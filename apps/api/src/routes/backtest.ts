import { Router } from "express";
import { query } from "@brokerforce/db";
import type { BacktestRequest, BacktestResult, BacktestExitEvent } from "@brokerforce/types";
import { runBacktest } from "../services/backtest.js";

// Per docs/API.md §7 and docs/specs/006-backtests/spec6.md.
export const backtestRouter = Router();

interface PriceHistoryRow {
  date: string;
  close: string;
  volume: string;
}

async function fetchPriceHistoryForPeriod(
  symbol: string,
  periodStart: string,
  periodEnd: string
): Promise<PriceHistoryRow[]> {
  return query<PriceHistoryRow>(
    `SELECT "timestamp"::date::text AS date, close, volume
     FROM asset_price_history
     WHERE asset_symbol = $1 AND "timestamp" >= $2 AND "timestamp" <= $3
     ORDER BY "timestamp" ASC`,
    [symbol, periodStart, periodEnd]
  );
}

backtestRouter.post("/", async (req, res) => {
  const body = req.body as BacktestRequest;

  if (!body.pairId || body.rangeMin == null || body.rangeMax == null || !body.periodStart || !body.periodEnd) {
    res.status(400).json({ error: "pairId, rangeMin, rangeMax, periodStart, and periodEnd are required" });
    return;
  }
  if (body.rangeMin >= body.rangeMax) {
    res.status(400).json({ error: "rangeMin must be less than rangeMax" });
    return;
  }

  const pairRows = await query<{ id: string; asset_a: string; asset_b: string }>(
    `SELECT id, asset_a, asset_b FROM pairs WHERE id = $1`,
    [body.pairId]
  );
  const pair = pairRows[0];
  if (!pair) {
    res.status(404).json({ error: "pair not found", pairId: body.pairId });
    return;
  }

  const [historyA, historyB] = await Promise.all([
    fetchPriceHistoryForPeriod(pair.asset_a, body.periodStart, body.periodEnd),
    fetchPriceHistoryForPeriod(pair.asset_b, body.periodStart, body.periodEnd),
  ]);

  // Align by date (inner join) -- same reasoning as
  // apps/pair-engine/src/compute-metrics.ts's alignByDate: the two assets
  // won't always have identical trading-day coverage.
  const byDateB = new Map(historyB.map((r) => [r.date, r]));
  const aligned: { date: string; closeA: number; closeB: number; volumeA: number; volumeB: number }[] = [];
  for (const rowA of historyA) {
    const rowB = byDateB.get(rowA.date);
    if (rowB) {
      aligned.push({
        date: rowA.date,
        closeA: Number(rowA.close),
        closeB: Number(rowB.close),
        volumeA: Number(rowA.volume),
        volumeB: Number(rowB.volume),
      });
    }
  }

  // Per spec6.md's acceptance criteria: if requested period exceeds
  // available history, either shorten with a clear note or decline with a
  // clear reason -- never silently extrapolate. MIN_POINTS chosen for
  // consistency with apps/pair-engine's MIN_POINTS_FOR_STATS -- below this,
  // computing anything meaningful (especially IL, which only uses start/end)
  // would be noise dressed up as a result.
  const MIN_POINTS = 3;
  if (aligned.length < MIN_POINTS) {
    res.status(422).json({
      error: "insufficient aligned price history for the requested period",
      pointsFound: aligned.length,
      minimumRequired: MIN_POINTS,
      reason:
        aligned.length === 0
          ? "no overlapping price data exists for both assets in this period"
          : "too few aligned data points to compute a meaningful result -- declining rather than extrapolating",
    });
    return;
  }

  const requestedDays =
    (new Date(body.periodEnd).getTime() - new Date(body.periodStart).getTime()) / (1000 * 60 * 60 * 24);
  let shortenedNote: string | null = null;
  if (aligned.length < requestedDays * 0.8) {
    // Real data covers meaningfully less than what was requested (e.g. the
    // asset wasn't tracked yet for part of the period) -- proceed using
    // what's actually available, but say so explicitly rather than silently
    // computing over a shorter period than the user asked for.
    shortenedNote = `Requested ~${Math.round(requestedDays)} days but only ${aligned.length} days of aligned data were available; results reflect the available period only.`;
  }

  const feeTier = body.feeTier ?? 0.003; // 0.3%, a common default tier -- not from any spec'd source
  const result = runBacktest({
    pricesA: aligned.map((a) => a.closeA),
    pricesB: aligned.map((a) => a.closeB),
    volumesA: aligned.map((a) => a.volumeA),
    volumesB: aligned.map((a) => a.volumeB),
    dates: aligned.map((a) => a.date),
    rangeMin: body.rangeMin,
    rangeMax: body.rangeMax,
    feeTier,
    positionSizeUsd: body.positionSizeUsd,
  });

  const insertRows = await query<{ id: string; created_at: string }>(
    `INSERT INTO backtest_results (
       pair_id, range_min, range_max, period_start, period_end, fee_tier,
       fees_earned, il_estimate, net_pnl, net_pnl_pct, time_in_range_pct, exit_count,
       exit_timeline, position_size_usd, data_granularity, assumed_pool_share_used
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id, created_at`,
    [
      pair.id,
      body.rangeMin,
      body.rangeMax,
      body.periodStart,
      body.periodEnd,
      feeTier,
      result.feesEarnedUsd,
      result.ilEstimate,
      result.netPnlUsd,
      result.netPnlPct,
      result.timeInRangePct,
      result.exitCount,
      JSON.stringify(result.exitTimeline),
      result.positionSizeUsd,
      "daily", // per Database.md §2 -- update once the hourly upgrade lands
      result.assumedPoolShareUsed,
    ]
  );

  const inserted = insertRows[0];
  if (!inserted) {
    throw new Error("INSERT INTO backtest_results returned no rows");
  }

  const response: BacktestResult = {
    id: inserted.id,
    pairId: pair.id,
    rangeMin: body.rangeMin,
    rangeMax: body.rangeMax,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd,
    feeTier,
    feesEarned: result.feesEarnedUsd,
    ilEstimate: result.ilEstimate,
    netPnl: result.netPnlUsd,
    netPnlPct: result.netPnlPct,
    timeInRangePct: result.timeInRangePct,
    exitCount: result.exitCount,
    exitTimeline: result.exitTimeline,
    positionSizeUsd: result.positionSizeUsd,
    dataGranularity: "daily",
    assumedPoolShareUsed: result.assumedPoolShareUsed,
    createdAt: inserted.created_at,
  };

  res.json(shortenedNote ? { ...response, note: shortenedNote } : response);
});

backtestRouter.get("/:simulationId", async (req, res) => {
  const rows = await query<{
    id: string;
    pair_id: string;
    range_min: string;
    range_max: string;
    period_start: string;
    period_end: string;
    fee_tier: string;
    fees_earned: string;
    il_estimate: string;
    net_pnl: string;
    net_pnl_pct: string;
    time_in_range_pct: string;
    exit_count: number;
    exit_timeline: BacktestExitEvent[];
    position_size_usd: string;
    data_granularity: "daily" | "hourly";
    assumed_pool_share_used: string;
    created_at: string;
  }>(
    `SELECT id, pair_id, range_min, range_max, period_start, period_end, fee_tier,
            fees_earned, il_estimate, net_pnl, net_pnl_pct, time_in_range_pct, exit_count,
            exit_timeline, position_size_usd, data_granularity, assumed_pool_share_used, created_at
     FROM backtest_results WHERE id = $1`,
    [req.params.simulationId]
  );

  const r = rows[0];
  if (!r) {
    res.status(404).json({ error: "simulation not found", simulationId: req.params.simulationId });
    return;
  }
  const result: BacktestResult = {
    id: r.id,
    pairId: r.pair_id,
    rangeMin: Number(r.range_min),
    rangeMax: Number(r.range_max),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    feeTier: Number(r.fee_tier),
    feesEarned: Number(r.fees_earned),
    ilEstimate: Number(r.il_estimate),
    netPnl: Number(r.net_pnl),
    netPnlPct: Number(r.net_pnl_pct),
    timeInRangePct: Number(r.time_in_range_pct),
    exitCount: r.exit_count,
    // pg returns JSONB already parsed -- no JSON.parse needed.
    exitTimeline: r.exit_timeline,
    positionSizeUsd: Number(r.position_size_usd),
    dataGranularity: r.data_granularity,
    assumedPoolShareUsed: Number(r.assumed_pool_share_used),
    createdAt: r.created_at,
  };

  res.json(result);
});
