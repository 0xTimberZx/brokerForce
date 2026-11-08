// /ranks (spec 022, Phase 2): the ORT rank tracker inside the terminal. Daily
// rank dots for the run's top 10 (or one pair), the 7-day average, the 14-day
// trend with its 7-day extension, and a see-through price layer for a single
// pair. Every setting lives in the URL, and ?asOf= rebuilds a past run's
// ranking, so a link from a group post opens exactly the view it describes.

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CanonicalWindow, PairHistoryResponse, RanksResponse } from "@brokerforce/types";
import { fetchPairHistory, fetchRanks } from "../api/client";
import { readView, shortDate, writeView, type RanksView } from "../ranks/urlState";

const WINDOWS: CanonicalWindow[] = [30, 90, 200];
const RANGES: RanksView["range"][] = ["30", "90", "all"];
// Distinct but muted series colours for the all-pairs view. Amber is left out:
// the terminal reserves it for the ORT score.
const PALETTE = ["#6FA8DC", "#93C47D", "#C27BA0", "#76A5AF", "#B4A7D6", "#E06666", "#FFD966", "#A2C4C9", "#D5A6BD", "#8E7CC3", "#F9CB9C"];

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: RanksResponse };

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (v: T) => void;
  format: (v: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex border border-line divide-x divide-line">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={
            "px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors " +
            (o === value ? "bg-ink text-bg-deep" : "text-ink-muted hover:text-ink")
          }
        >
          {format(o)}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-1.5 font-mono text-[11px] ${disabled ? "text-ink-muted/50" : "text-ink-muted"}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-current" />
      {label}
    </label>
  );
}

export function RanksPage() {
  const [params, setParams] = useSearchParams();
  const view = readView(params);
  const update = (patch: Partial<RanksView>) => setParams(writeView({ ...view, ...patch }), { replace: true });

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [price, setPrice] = useState<PairHistoryResponse | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    fetchRanks({ window: view.w, asOf: view.asOf, pair: view.pair, range: view.range })
      .then((data) => active && setLoad({ status: "loaded", data }))
      .catch((err) => active && setLoad({ status: "error", message: err instanceof Error ? err.message : "Unknown error" }));
    return () => {
      active = false;
    };
  }, [view.w, view.asOf, view.pair, view.range]);

  // Price layer: single pair only, the pair's own close ratio (A in B).
  useEffect(() => {
    let active = true;
    setPrice(null);
    if (!view.pair || !view.price) return;
    const [a, b] = view.pair.split("-");
    fetchPairHistory(a!, b!, 200)
      .then((h) => active && setPrice(h))
      .catch(() => active && setPrice(null));
    return () => {
      active = false;
    };
  }, [view.pair, view.price]);

  const data = load.status === "loaded" ? load.data : null;
  const single = view.pair && data ? data.series.find((s) => `${s.assetA}-${s.assetB}` === view.pair || `${s.assetB}-${s.assetA}` === view.pair) : null;
  const shown = data ? (single ? [single] : data.series.filter((s) => data.top.some((t) => t.pairId === s.pairId && t.rank <= 10))) : [];

  const chartRows = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string | null>>();
    const row = (date: string) => {
      let r = byDate.get(date);
      if (!r) {
        r = { date };
        byDate.set(date, r);
      }
      return r;
    };
    for (const s of shown) {
      for (const p of s.ranks) {
        const r = row(p.date);
        r[`r_${s.pairId}`] = p.rank;
        r[`a_${s.pairId}`] = p.avg7;
      }
      if (single) {
        for (const t of s.trend) {
          if (t.phase === "fit") row(t.date).fit = t.rank;
          else if (view.ext) row(t.date).ext = t.rank;
        }
        // join the extension to the end of the fit line
        const lastFit = [...s.trend].reverse().find((t) => t.phase === "fit");
        if (lastFit && view.ext) row(lastFit.date).ext = lastFit.rank;
      }
    }
    if (single && price && view.price) {
      const first = shown[0]?.ranks[0]?.date ?? "";
      const flip = single.assetA !== price.assetA; // keep the ratio as the pair is named here
      for (const p of price.series) {
        if (p.date < first || !byDate.has(p.date)) continue;
        row(p.date).price = flip ? p.closeB / p.closeA : p.closeA / p.closeB;
      }
    }
    return [...byDate.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  }, [shown, single, price, view.ext, view.price]);

  const maxRank = data?.pairsRanked || 100;
  const shownMax = Math.min(maxRank, Math.max(10, ...shown.flatMap((s) => s.ranks.map((p) => p.rank))) + 2);
  const pinned = data && data.asOf && data.latest && data.asOf !== data.latest;

  const pickPair = (raw: string) => {
    const m = /^([A-Za-z0-9]{2,10})\s*[-/ ]\s*([A-Za-z0-9]{2,10})$/.exec(raw.trim());
    if (m) update({ pair: `${m[1]!.toUpperCase()}-${m[2]!.toUpperCase()}` });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-xl text-ink">Ranks</h1>
        <p className="font-body text-xs text-ink-muted mt-1">
          Daily ORT rank among {data?.pairsRanked ?? "…"} scored pairs. Lower is better; #1 is the highest score.
        </p>
      </div>

      {pinned && (
        <div className="border border-line bg-bg-panel px-4 py-2 flex flex-wrap items-center gap-3 font-body text-sm">
          <span className="text-ink">Showing the {shortDate(data.asOf!)} print</span>
          <button type="button" onClick={() => update({ asOf: null })} className="text-signal hover:underline underline-offset-4">
            Jump to latest ({shortDate(data.latest!)})
          </button>
        </div>
      )}

      <section className="border border-line bg-bg-panel p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="ORT window" options={WINDOWS} value={view.w} onChange={(w) => update({ w })} format={(w) => `${w}d`} />
          <Segmented label="Range" options={RANGES} value={view.range} onChange={(range) => update({ range })} format={(r) => (r === "all" ? "All" : `${r}d`)} />
          <label className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span className="uppercase tracking-widest text-[10px]">As of</span>
            <input
              type="date"
              value={view.asOf ?? data?.latest ?? ""}
              max={data?.latest ?? undefined}
              onChange={(e) => update({ asOf: e.target.value && e.target.value !== data?.latest ? e.target.value : null })}
              className="bg-bg-deep border border-line text-ink px-2 py-1 font-mono text-[11px]"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              pickPair(search);
            }}
            className="flex items-center gap-2"
          >
            <input
              list="ranks-pairs"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (data?.pairs.some((p) => `${p.assetA}/${p.assetB}` === e.target.value)) pickPair(e.target.value);
              }}
              placeholder="Search a pair, e.g. ETH/XRP"
              className="bg-bg-deep border border-line text-ink px-2 py-1 font-mono text-[11px] w-48"
            />
            <datalist id="ranks-pairs">
              {data?.pairs.map((p) => (
                <option key={p.pairId} value={`${p.assetA}/${p.assetB}`}>
                  #{p.rank}
                </option>
              ))}
            </datalist>
          </form>
          {view.pair && (
            <button type="button" onClick={() => { setSearch(""); update({ pair: null }); }} className="font-mono text-[11px] text-ink-muted hover:text-ink">
              {view.pair.replace("-", "/")} ✕ all pairs
            </button>
          )}
          <span className="ml-auto flex items-center gap-3">
            <Toggle label="7d avg" on={view.avg} onChange={(avg) => update({ avg })} />
            <Toggle label="trend ext." on={view.ext} onChange={(ext) => update({ ext })} disabled={!view.pair} />
            <Toggle label="price" on={view.price} onChange={(p) => update({ price: p })} disabled={!view.pair} />
          </span>
        </div>

        {load.status === "loading" && <p className="font-body text-sm text-ink-muted py-10 text-center">Loading ranks…</p>}
        {load.status === "error" && <p className="font-mono text-xs text-ink-muted py-10">Ranks unavailable: {load.message}</p>}
        {data && view.pair && !single && (
          <p className="font-body text-sm text-ink-muted">
            {view.pair.replace("-", "/")} wasn't ranked on the {data.asOf ? shortDate(data.asOf) : "selected"} run for this window.
          </p>
        )}
        {data && shown.length > 0 && (
          <div className="h-80 md:h-96">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#2A3A35" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "#8FA39B", fontSize: 10 }} stroke="#2A3A35" minTickGap={24} />
                <YAxis yAxisId="rank" reversed domain={[1, shownMax]} allowDecimals={false} tick={{ fill: "#8FA39B", fontSize: 10 }} stroke="#2A3A35" width={36} />
                {single && view.price && (
                  <YAxis yAxisId="price" orientation="right" domain={["auto", "auto"]} tick={{ fill: "#8FA39B", fontSize: 10 }} stroke="#2A3A35" width={52}
                    tickFormatter={(v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2))} />
                )}
                <Tooltip
                  contentStyle={{ background: "#15201D", border: "1px solid #2A3A35", fontSize: 11 }}
                  labelFormatter={(d) => shortDate(String(d))}
                  formatter={(value, name) => {
                    const key = String(name);
                    const s = shown.find((x) => key.endsWith(x.pairId));
                    const label =
                      key === "fit" ? "14d trend" : key === "ext" ? "extension" : key === "price" ? "price" :
                      `${s ? `${s.assetA}/${s.assetB}` : ""}${key.startsWith("a_") ? " 7d avg" : ""}`;
                    return [typeof value === "number" ? (key === "price" ? value.toPrecision(4) : value) : value, label];
                  }}
                />
                {single && view.price && (
                  <Area yAxisId="price" dataKey="price" type="monotone" stroke="#76A5AF" strokeOpacity={0.35} fill="#76A5AF" fillOpacity={0.08} connectNulls isAnimationActive={false} />
                )}
                {shown.map((s, i) => {
                  const color = single ? "#E8EDE9" : PALETTE[i % PALETTE.length]!;
                  return [
                    <Scatter key={`r_${s.pairId}`} yAxisId="rank" dataKey={`r_${s.pairId}`} fill={color} isAnimationActive={false} shape="circle" />,
                    view.avg ? (
                      <Line key={`a_${s.pairId}`} yAxisId="rank" dataKey={`a_${s.pairId}`} stroke={color} strokeOpacity={single ? 0.6 : 0.45} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
                    ) : null,
                  ];
                })}
                {single && (
                  <Line yAxisId="rank" dataKey="fit" stroke={(single.trendSlope ?? 0) <= 0 ? "#5FA97C" : "#C96A5B"} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
                )}
                {single && view.ext && (
                  <Line yAxisId="rank" dataKey="ext" stroke={(single.trendSlope ?? 0) <= 0 ? "#5FA97C" : "#C96A5B"} strokeDasharray="4 4" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {data && data.top.length > 0 && (
        <section className="border border-line bg-bg-panel p-4">
          <h2 className="font-display text-sm text-ink">
            Top 10 · {view.w}d window{data.asOf ? ` · ${shortDate(data.asOf)}` : ""}
          </h2>
          <table className="mt-3 w-full font-mono text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-line">
                <th className="text-right py-1.5 w-8">#</th>
                <th className="text-left py-1.5 pl-3">Pair</th>
                <th className="text-right py-1.5">7d avg</th>
                <th className="text-right py-1.5" title="14-day trend, ranks per day (negative = climbing)">Trend</th>
                <th className="text-right py-1.5 text-signal">ORT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.top.map((t, i) => {
                const color = single ? undefined : PALETTE[i % PALETTE.length];
                const slope = t.trendSlope;
                return (
                  <tr key={t.pairId} className={t.searched ? "bg-bg-deep" : ""}>
                    <td className="text-right py-2 tabular-nums text-ink-muted">{t.rank}</td>
                    <td className="py-2 pl-3">
                      <button type="button" onClick={() => update({ pair: `${t.assetA}-${t.assetB}` })} className="text-ink hover:underline underline-offset-4 inline-flex items-center gap-2">
                        {color && <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />}
                        {t.assetA}/{t.assetB}
                      </button>
                      <Link to={`/pairs/${t.assetA}/${t.assetB}`} className="ml-2 text-[10px] text-ink-muted hover:text-ink">open ↗</Link>
                    </td>
                    <td className="text-right py-2 tabular-nums text-ink-muted">{t.avg7 ?? "—"}</td>
                    <td className={`text-right py-2 tabular-nums ${slope === null ? "text-ink-muted" : slope < -0.05 ? "text-pos" : slope > 0.05 ? "text-neg" : "text-ink-muted"}`}>
                      {slope === null ? "—" : `${slope < -0.05 ? "↑" : slope > 0.05 ? "↓" : "→"} ${Math.abs(slope).toFixed(2)}/d`}
                    </td>
                    <td className="text-right py-2 tabular-nums text-signal">{t.score.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 font-body text-[11px] text-ink-muted">
            Trend is a straight line through the last 14 days of rank, extended 7 days. It describes the recent path; it isn't a forecast.
          </p>
        </section>
      )}
    </div>
  );
}
