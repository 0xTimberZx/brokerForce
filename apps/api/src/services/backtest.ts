// Core backtest simulation logic. Per docs/specs/006-backtests/spec6.md.
//
// REAL GAP, documented rather than silently resolved: computing dollar fees
// earned needs a position size and a pool-liquidity share -- neither is
// listed as a spec input (spec6.md's setup panel only asks for pair, range,
// period, fee tier), and neither has real data behind it anyway, since pool
// TVL doesn't exist yet (apps/ingestion only covers asset-level data; pool
// ingestion is separate, later work). Time-in-range, exit count, and IL are
// all precise -- they only depend on price history, which IS real. Fees are
// necessarily a rough, clearly-labeled estimate.
//
// The model adopted here:
//   - positionSizeUsd: a real, required input even though spec6.md didn't
//     list it -- there's no way to express a dollar P&L without one.
//     Defaults to $10,000 if the caller doesn't supply one, purely as a
//     consistent baseline for comparing scenarios within one session, not a
//     claim about what's "typical."
//   - A fixed assumed pool-share constant (BASE_POOL_SHARE), scaled by a
//     concentration factor that rewards a tighter range -- consistent with
//     how concentrated liquidity actually behaves (a narrower range earns a
//     larger share of fees per dollar of capital than a wide one), but NOT
//     Uniswap v3's actual sqrt-price-tick math, which is a meaningfully
//     bigger undertaking and would still be using a guessed pool-share
//     constant underneath regardless of how precisely the curve math were
//     implemented. A simple, honestly-labeled multiplier was judged more
//     trustworthy than a partially-correct version of the real formula.
//
// Treat fees/net P&L from this model as DIRECTIONAL and COMPARATIVE --
// useful for "is a tighter range better than a wider one for this pair,"
// not as a dollar prediction. Time-in-range, exit count, and IL don't carry
// this caveat; they're computed directly from real price history.

import { impermanentLossEstimate, computeRangeStreaks, pairVolumeProxy } from "@brokerforce/stats";

export const DEFAULT_POSITION_SIZE_USD = 10_000;
const BASE_POOL_SHARE = 0.01; // 1% -- an assumed, clearly-arbitrary baseline, not derived from anything
const MAX_CONCENTRATION_FACTOR = 50; // caps the reward for an extremely tight range, avoiding absurd values
const MAX_EFFECTIVE_POOL_SHARE = 0.5; // a position can't realistically be assumed to own most of a real pool

export interface BacktestInput {
  pricesA: number[];
  pricesB: number[];
  volumesA: number[];
  volumesB: number[];
  dates: string[]; // same length as the price/volume arrays, oldest first
  rangeMin: number; // explicit price-ratio bounds -- callers translate a %-width input into these before calling this function
  rangeMax: number;
  feeTier: number; // fractional, e.g. 0.003 for 0.3%
  positionSizeUsd?: number;
}

export interface BacktestExitEvent {
  date: string;
  type: "exit" | "re-entry";
}

export interface BacktestResult {
  feesEarnedUsd: number;
  ilEstimate: number; // fractional, e.g. -0.02 for -2%
  netPnlUsd: number;
  netPnlPct: number;
  timeInRangePct: number;
  exitCount: number;
  exitTimeline: BacktestExitEvent[];
  positionSizeUsd: number;
  // Surfaced so the caller/UI can disclose the assumption rather than
  // present feesEarnedUsd as if it were a precise figure.
  assumedPoolShareUsed: number;
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const { pricesA, pricesB, dates, rangeMin, rangeMax, feeTier } = input;
  const positionSizeUsd = input.positionSizeUsd ?? DEFAULT_POSITION_SIZE_USD;

  if (pricesA.length !== pricesB.length || pricesA.length !== dates.length) {
    throw new Error("runBacktest requires pricesA, pricesB, and dates to be the same length");
  }

  const ratios = pricesA.map((a, i) => a / pricesB[i]!); // equal-length guaranteed by the check above

  const { inRangeFlags, exitCount } = computeRangeStreaks(ratios, (r) => r >= rangeMin && r <= rangeMax);

  const timeInRangePct = inRangeFlags.filter(Boolean).length / inRangeFlags.length;

  const exitTimeline: BacktestExitEvent[] = [];
  for (let i = 1; i < inRangeFlags.length; i++) {
    // All index accesses below are within [0, length) by loop bounds.
    // dates[i] is string | undefined under noUncheckedIndexedAccess, but
    // i < inRangeFlags.length === pricesA.length === dates.length (validated
    // at the top of this function), so the ! assertion is safe here.
    if (inRangeFlags[i - 1]! && !inRangeFlags[i]!) exitTimeline.push({ date: dates[i]!, type: "exit" });
    if (!inRangeFlags[i - 1]! && inRangeFlags[i]!) exitTimeline.push({ date: dates[i]!, type: "re-entry" });
  }

  const rangeWidthPct = (rangeMax - rangeMin) / ((rangeMin + rangeMax) / 2);
  const concentrationFactor = Math.min(MAX_CONCENTRATION_FACTOR, Math.max(1, 1 / rangeWidthPct));
  const assumedPoolShareUsed = Math.min(MAX_EFFECTIVE_POOL_SHARE, BASE_POOL_SHARE * concentrationFactor);

  const pairVolume = pairVolumeProxy(input.volumesA, input.volumesB);
  let feesEarnedUsd = 0;
  for (let i = 0; i < pairVolume.length; i++) {
    if (inRangeFlags[i]) {
      feesEarnedUsd += pairVolume[i]! * feeTier * assumedPoolShareUsed; // i < pairVolume.length by loop bounds
    }
  }

  const ilEstimate = impermanentLossEstimate(pricesA, pricesB);
  const ilUsd = ilEstimate * positionSizeUsd;
  const netPnlUsd = feesEarnedUsd + ilUsd;
  const netPnlPct = netPnlUsd / positionSizeUsd;

  return {
    feesEarnedUsd,
    ilEstimate,
    netPnlUsd,
    netPnlPct,
    timeInRangePct,
    exitCount,
    exitTimeline,
    positionSizeUsd,
    assumedPoolShareUsed,
  };
}

/** Translates a %-width input (e.g. 0.1 = +/-10% around the entry price
 * ratio) into explicit rangeMin/rangeMax bounds. Per spec6.md: "Range
 * definition: min/max price bounds, derived from either user input or a
 * translated %-width input." */
export function widthPctToRange(entryRatio: number, widthPct: number): { rangeMin: number; rangeMax: number } {
  const half = widthPct / 2;
  return {
    rangeMin: entryRatio * (1 - half),
    rangeMax: entryRatio * (1 + half),
  };
}
