import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { CanonicalWindow, OrtNetworkCount, OrtRankedPair, QuadrantLabel, ScoreTrend } from "@brokerforce/types";
import { fetchOrtNetworks, fetchOrtRanked } from "../api/client";
import { QuoteLensToggle, type QuoteLens } from "./QuoteLensToggle";
import { fmtTrendChange } from "./OrtTrendTags";
import { networkName, networkShort } from "./networks";

type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; pairs: OrtRankedPair[] };

const WINDOWS: CanonicalWindow[] = [30, 90, 200];
/** Network badges shown per row before collapsing into "+N". */
const MAX_BADGES = 3;

// Signal as a mark, not a word: solid for prime, softer for active, hollow
// for quiet, a cross for avoid. Kept monochrome: amber stays reserved for the
// score, green/red for direction (tailwind.config).
const SIGNAL_MARK: Record<QuadrantLabel, { glyph: string; cls: string }> = {
  prime: { glyph: "●", cls: "text-ink" },
  active: { glyph: "●", cls: "text-ink-muted" },
  quiet: { glyph: "○", cls: "text-ink-muted" },
  avoid: { glyph: "×", cls: "text-ink-muted" },
};

const MOMENTUM: Record<ScoreTrend, { glyph: string; cls: string }> = {
  rising: { glyph: "↑", cls: "text-pos" },
  falling: { glyph: "↓", cls: "text-neg" },
  flat: { glyph: "→", cls: "text-ink-muted" },
};

const REGIME_TEXT = {
  "toward-prime": "moving toward prime (30d vs 90d)",
  "away-from-prime": "moving away from prime (30d vs 90d)",
  flat: "flat (30d vs 90d)",
} as const;

function parseWindow(raw: string | null): CanonicalWindow {
  const n = Number(raw);
  return n === 30 || n === 200 ? n : 90;
}

/** Everything the row no longer spells out, for the hover/long-press title. */
function rowDetail(p: OrtRankedPair): string {
  const lines = [
    `Signal: ${p.quadrantLabel ?? "n/a"}`,
    `Regime: ${p.trendDirection ? REGIME_TEXT[p.trendDirection] : "n/a"}`,
    `Momentum: ${
      p.scoreTrend
        ? `${p.scoreTrend}${p.scoreTrendChange !== null ? ` (${fmtTrendChange(p.scoreTrendChange)} over 14d)` : ""}`
        : "building (not enough history yet)"
    }`,
  ];
  if (p.networks.length) lines.push(`Networks: ${p.networks.map(networkName).join(", ")}`);
  if (p.thinLiquidity) lines.push("Thin liquidity: deepest pool is below a usable size");
  if (p.confidence === "low") lines.push("Low confidence: limited data behind this score");
  return lines.join("\n");
}

/**
 * spec1.md's Top Opportunities: the top 10 pairs by ORT score from 004's
 * ranked endpoint. Window (30/90/200d), quote lens and network live in the
 * URL (?w=, ?q=gold, ?net=) so a view can be shared or bookmarked. Rows show
 * only rank, signal mark, pair, networks, momentum arrow and score; the rest
 * is in each row's title and on the pair's own page.
 */
export function TopOpportunitiesPanel() {
  const [params, setParams] = useSearchParams();
  const win = parseWindow(params.get("w"));
  const lens: QuoteLens = params.get("q") === "gold" ? "gold" : "usd";
  const network = params.get("net") || null;

  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [networks, setNetworks] = useState<OrtNetworkCount[]>([]);

  function update(next: { w?: CanonicalWindow; q?: QuoteLens; net?: string | null }) {
    const p = new URLSearchParams(params);
    const set = (key: string, value: string | null, fallback: string) =>
      value === null || value === fallback ? p.delete(key) : p.set(key, value);
    if (next.w !== undefined) set("w", String(next.w), "90");
    if (next.q !== undefined) set("q", next.q, "usd");
    if (next.net !== undefined) set("net", next.net, "");
    setParams(p, { replace: true });
  }

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    fetchOrtRanked(win, 10, lens, network)
      .then((pairs) => active && setState({ status: "loaded", pairs }))
      .catch((err) =>
        active && setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" })
      );
    return () => {
      active = false;
    };
  }, [win, lens, network]);

  useEffect(() => {
    let active = true;
    fetchOrtNetworks(win, lens).then((n) => active && setNetworks(n));
    return () => {
      active = false;
    };
  }, [win, lens]);

  return (
    <section className="border border-line bg-bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-sm text-ink">Top opportunities</h2>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="ORT window" className="inline-flex border border-line divide-x divide-line">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={w === win}
                onClick={() => update({ w })}
                className={
                  "px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors " +
                  (w === win ? "bg-ink text-bg-deep" : "text-ink-muted hover:text-ink")
                }
              >
                {w}d
              </button>
            ))}
          </div>
          <QuoteLensToggle value={lens} onChange={(q) => update({ q })} />
        </div>
      </div>

      {networks.length > 0 && (
        <label className="mt-3 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
          <span className="uppercase tracking-widest text-[10px]">Network</span>
          <select
            value={network ?? ""}
            onChange={(e) => update({ net: e.target.value || null })}
            className="bg-bg-deep border border-line text-ink px-2 py-1 font-mono text-[11px]"
          >
            <option value="">All networks</option>
            {networks.map((n) => (
              <option key={n.network} value={n.network}>
                {networkName(n.network)} ({n.pairs})
              </option>
            ))}
          </select>
        </label>
      )}

      {state.status === "loading" && <p className="font-body text-sm text-ink-muted mt-4">Loading rankings…</p>}

      {state.status === "error" && (
        <p className="font-mono text-xs text-ink-muted mt-4">Rankings unavailable: {state.message}</p>
      )}

      {state.status === "loaded" && state.pairs.length === 0 && (
        <p className="font-body text-sm text-ink-muted mt-4 max-w-prose">
          {network
            ? `No scored pairs have a usable pool on ${networkName(network)} for this view. Try another network or All networks.`
            : lens === "gold"
              ? "No gold-denominated pairs hold an ORT score for this window yet. Switch to USD to see the full ranking."
              : "No pairs hold an ORT score for this window yet. Scores appear once a pair clears the active-tier gate ($50k pool TVL, $10k 7-day average volume)."}
        </p>
      )}

      {state.status === "loaded" && state.pairs.length > 0 && (
        <>
          <ol className="mt-3 divide-y divide-line">
            {state.pairs.map((p, i) => {
              const mark = p.quadrantLabel ? SIGNAL_MARK[p.quadrantLabel] : null;
              const momentum = p.scoreTrend ? MOMENTUM[p.scoreTrend] : null;
              const extra = p.networks.length - MAX_BADGES;
              return (
                <li key={p.pairId}>
                  <Link
                    to={`/pairs/${p.assetA}/${p.assetB}`}
                    title={rowDetail(p)}
                    className="flex items-center gap-3 py-2.5 group"
                  >
                    <span className="font-mono text-xs text-ink-muted w-5 text-right tabular-nums">{i + 1}</span>
                    <span className={`w-3 text-center text-[13px] leading-none ${mark?.cls ?? "text-ink-muted"}`} aria-hidden>
                      {mark?.glyph ?? "·"}
                    </span>
                    <span className="font-body text-sm text-ink group-hover:underline underline-offset-4">
                      {p.assetA}/{p.assetB}
                    </span>
                    <span className="flex items-center gap-1 ml-1 min-w-0 overflow-hidden">
                      {p.networks.slice(0, MAX_BADGES).map((n) => (
                        <span
                          key={n}
                          className="font-mono text-[9px] tracking-wide text-ink-muted border border-line px-1 py-px"
                        >
                          {networkShort(n)}
                        </span>
                      ))}
                      {extra > 0 && <span className="font-mono text-[9px] text-ink-muted">+{extra}</span>}
                    </span>
                    <span className="ml-auto flex items-center gap-3 font-mono text-sm">
                      {p.thinLiquidity && (
                        <span className="text-[10px] uppercase tracking-wide text-neg" aria-label="thin liquidity">
                          thin
                        </span>
                      )}
                      <span className={`w-3 text-center ${momentum?.cls ?? "text-ink-muted"}`} aria-hidden>
                        {momentum?.glyph ?? "·"}
                      </span>
                      <span className="text-signal font-medium tabular-nums w-6 text-right">{p.score.toFixed(0)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 pt-3 border-t border-line font-mono text-[10px] text-ink-muted">
            <span className="text-ink">●</span> prime ● active ○ quiet × avoid ·{" "}
            <span className="text-pos">↑</span>
            <span className="text-neg">↓</span> 14-day score trend · <span className="text-signal">score</span> 0–100 ·
            full detail on hover or on the pair's page
          </p>
        </>
      )}
    </section>
  );
}
