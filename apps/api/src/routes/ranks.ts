// GET /ranks (spec 022, Phase 2): the rank-tracker view, rebuilt for any run
// date from ort_score_history. One request returns everything the page draws:
// the top 10 (plus a searched pair) as of the run, their daily ranks with a
// 7-day average, the 14-day trend with its 7-day extension, and every ranked
// pair for the search box. Behind requireMember like every data route.
import { Router } from "express";
import { query } from "@brokerforce/db";
import type { RanksResponse, RanksSeriesPair } from "@brokerforce/types";
import { fetchFrom, fitTrend, parseRanksParams, rangeStart, rollingAverage } from "../services/ranks.js";

export const ranksRouter = Router();

interface RankedRow {
  d: string;
  pair_id: string;
  asset_a: string;
  asset_b: string;
  score: string;
  rk: number;
  n: number;
}

ranksRouter.get("/", async (req, res) => {
  const params = parseRanksParams(req.query as Record<string, unknown>);

  // The run the view is pinned to: the last scored day on or before asOf.
  const [{ latest, effective } = { latest: null, effective: null }] = await query<{
    latest: string | null;
    effective: string | null;
  }>(
    `SELECT max(computed_at::date)::text AS latest,
            max(computed_at::date) FILTER (WHERE computed_at::date <= COALESCE($2::date, 'infinity'::date))::text AS effective
     FROM ort_score_history WHERE "window" = $1`,
    [params.window, params.asOf]
  );
  if (!effective || !latest) {
    res.json({ window: params.window, asOf: null, latest, pairsRanked: 0, top: [], series: [], pairs: [] } satisfies RanksResponse);
    return;
  }

  // One score per pair per day (the day's last run), ranked within each day.
  // Every value is a bound parameter; nothing from the URL is spliced in.
  const rows = await query<RankedRow>(
    `WITH daily AS (
       SELECT DISTINCT ON (h.pair_id, h.computed_at::date)
              h.pair_id, h.computed_at::date AS d, h.score
       FROM ort_score_history h
       WHERE h."window" = $1
         AND h.computed_at::date <= $2::date
         AND ($3::date IS NULL OR h.computed_at::date >= $3::date)
       ORDER BY h.pair_id, h.computed_at::date, h.computed_at DESC
     ), ranked AS (
       SELECT d, pair_id, score,
              ROW_NUMBER() OVER (PARTITION BY d ORDER BY score DESC, pair_id)::int AS rk,
              COUNT(*) OVER (PARTITION BY d)::int AS n
       FROM daily
     )
     SELECT r.d::text AS d, r.pair_id, p.asset_a, p.asset_b, r.score, r.rk, r.n
     FROM ranked r JOIN pairs p ON p.id = r.pair_id
     ORDER BY r.d`,
    [params.window, effective, fetchFrom(effective, params.range)]
  );

  const onDay = rows.filter((r) => r.d === effective);
  const pairsRanked = onDay[0]?.n ?? 0;

  // Pairs to draw: the run's top 10, plus the searched pair if it was ranked.
  const selected = new Set(onDay.filter((r) => r.rk <= 10).map((r) => r.pair_id));
  let searchedId: string | null = null;
  if (params.pair) {
    const [a, b] = params.pair;
    const hit = onDay.find((r) => (r.asset_a === a && r.asset_b === b) || (r.asset_a === b && r.asset_b === a));
    if (hit) {
      searchedId = hit.pair_id;
      selected.add(hit.pair_id);
    }
  }

  const start = rangeStart(effective, params.range);
  const byPair = new Map<string, RankedRow[]>();
  for (const r of rows) {
    if (!selected.has(r.pair_id)) continue;
    const list = byPair.get(r.pair_id) ?? [];
    list.push(r);
    byPair.set(r.pair_id, list);
  }

  const series: RanksSeriesPair[] = [];
  for (const [pairId, list] of byPair) {
    const points = list.map((r) => ({ date: r.d, rank: r.rk }));
    const avg = rollingAverage(points);
    const trend = fitTrend(points, pairsRanked);
    series.push({
      pairId,
      assetA: list[0]!.asset_a,
      assetB: list[0]!.asset_b,
      ranks: points
        .map((p, i) => ({ date: p.date, rank: p.rank, avg7: avg[i] ?? null }))
        .filter((p) => start === null || p.date >= start),
      trend: trend ? trend.points : [],
      trendSlope: trend ? trend.slope : null,
    });
  }

  const top = onDay
    .filter((r) => selected.has(r.pair_id))
    .sort((x, y) => x.rk - y.rk)
    .map((r) => {
      const s = series.find((p) => p.pairId === r.pair_id);
      const last = s?.ranks[s.ranks.length - 1];
      return {
        pairId: r.pair_id,
        assetA: r.asset_a,
        assetB: r.asset_b,
        rank: r.rk,
        score: Number(r.score),
        avg7: last?.avg7 ?? null,
        trendSlope: s?.trendSlope ?? null,
        searched: r.pair_id === searchedId,
      };
    });

  const body: RanksResponse = {
    window: params.window,
    asOf: effective,
    latest,
    pairsRanked,
    top,
    series,
    pairs: onDay
      .sort((x, y) => x.rk - y.rk)
      .map((r) => ({ pairId: r.pair_id, assetA: r.asset_a, assetB: r.asset_b, rank: r.rk })),
  };
  res.json(body);
});
