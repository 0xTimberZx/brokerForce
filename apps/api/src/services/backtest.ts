// Core backtest simulation logic. Per docs/specs/006-backtests/spec6.md, with
// the fee model rewired onto real pool data by spec10 (Fix 2).
//
// Fees are now grounded in the pair's actual pool -- its TVL and 24h volume,
// already ingested -- instead of the old asset-level trading-volume proxy
// (which produced absurd P&L, e.g. +$108M on BTC/ETH, because it multiplied a
// guessed pool-share constant by billions of dollars of asset volume).
//
// The model:
//   - positionSizeUsd: a real, required input even though spec6.md didn't
//     list it -- there's no way to express a dollar P&L without one.
//     Defaults to $10,000 if the caller doesn't supply one, purely as a
//     consistent baseline for comparing scenarios within one session, not a
//     claim about what's "typical."
//   - poolTvlUsd + poolVolumePerStepUsd: the pair's real pool depth and its
//     per-step (per-day for daily, per-hour for hourly) volume, read from the
//     `pools` table by the route. When present:
//       baseShare      = positionSize / (poolTvl + positionSize)  -- the LP's
//                        honest fraction of the pool once its capital is added.
//       effectiveShare = min(MAX_EFFECTIVE_POOL_SHARE, baseShare × concentrationFactor)
//                        -- a tighter range concentrates capital and earns a
//                        larger share per dollar (kept from the old model), but
//                        the pool's actual TVL now bounds it, so fees can't run
//                        away into the billions.
//       feesEarnedUsd  = Σ over in-range steps of poolVolumePerStep × feeTier × effectiveShare
//     This is still an ESTIMATE, not Uniswap v3's sqrt-price-tick math -- but
//     it's bounded by real pool liquidity rather than a free-floating constant.
//   - When no pool data (poolTvl ≤ 0 / absent): feesEarnedUsd = 0,
//     feeBasis = "unavailable", netPnl = IL only. Never a fabricated number.
//
// Time-in-range, exit count, and IL are precise -- computed directly from real
// price history -- and unchanged by this rework.

import { impermanentLossEstimate, computeRangeStreaks } from "@brokerforce/stats";

export const DEFAULT_POSITION_SIZE_USD = 10_000;
const MAX_CONCENTRATION_FACTOR = 50; // caps the reward for an extremely tight range (spec10 "pool"-basis fallback only)
const MAX_EFFECTIVE_POOL_SHARE = 0.5; // a position can't realistically be assumed to own most of a real pool
// Below this in-range liquidity fraction we treat the (top-40-tick) distribution
// snapshot as not covering the range and fall back to the "pool" model, rather
// than let an essentially-empty band inflate the share to the cap (spec 015).
const MIN_IN_RANGE_FRACTION = 0.001;
// The distribution's price scale must be within this factor of the pair's
// current ratio (after orientation) to be trusted as this pair's distribution.
const MAX_PRICE_SCALE_FACTOR = 5;

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
  // The pair's real pool depth + per-step volume (spec10 Fix 2), read from the
  // `pools` table by the route. Both required for a "pool"-basis fee estimate;
  // absent (or poolTvl ≤ 0) -> fees 0, feeBasis "unavailable".
  poolTvlUsd?: number;
  poolVolumePerStepUsd?: number; // pool 24h volume /1 (daily) or /24 (hourly)
  // The chosen pool's active-liquidity distribution (spec 012), for the
  // concentration-aware "tick"-basis fee model (spec 015). When present and
  // usable, the position competes only with the pool liquidity inside its
  // range, not the whole TVL. Absent/unusable -> falls back to the "pool" model.
  activeLiquidityDistribution?: { priceTick: number; liquidity: number }[];
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
  // "tick"        -- concentration-aware: the share competes only with the pool
  //                  liquidity inside the range, from the real distribution (spec 015).
  // "pool"        -- spec10 heuristic (pool has TVL/volume but no usable distribution).
  // "unavailable" -- no pool data; feesEarnedUsd is 0 and the UI shows
  //                  "needs pool data" rather than a fabricated figure.
  feeBasis: "tick" | "pool" | "unavailable";
}

type LiqBucket = { priceTick: number; liquidity: number };

/** Median of the finite, positive priceTicks -- a robust centre for the
 * distribution's price scale. Null when there are none. */
function medianPriceTick(dist: LiqBucket[]): number | null {
  const ps = dist.map((d) => d.priceTick).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (ps.length === 0) return null;
  const mid = Math.floor(ps.length / 2);
  return ps.length % 2 ? ps[mid]! : (ps[mid - 1]! + ps[mid]!) / 2;
}

/** PURE: the subgraph's priceTick is price0 (token0/token1, ordered by contract
 * address), which may be the RECIPROCAL of the pair's assetA/assetB ratio, or on
 * an unrelated scale. Orient the distribution to the pair's ratio:
 *  - pick same vs. reciprocal by whichever centre is closer (in log space) to currentRatio;
 *  - if even the closer centre is off by more than MAX_PRICE_SCALE_FACTOR, the
 *    distribution isn't this pair's -> return null (caller falls back).
 * Returns the (possibly inverted) buckets, else null. */
export function alignDistributionOrientation(dist: LiqBucket[], currentRatio: number): LiqBucket[] | null {
  if (!dist || dist.length === 0 || !Number.isFinite(currentRatio) || currentRatio <= 0) return null;
  const med = medianPriceTick(dist);
  if (med === null) return null;
  const sameGap = Math.abs(Math.log(med / currentRatio));
  const recipGap = Math.abs(Math.log(med * currentRatio)); // ln(med / (1/currentRatio))
  const invert = recipGap < sameGap;
  const chosenGap = invert ? recipGap : sameGap;
  if (chosenGap > Math.log(MAX_PRICE_SCALE_FACTOR)) return null; // wrong scale -> not this pair's distribution
  if (!invert) return dist.filter((d) => Number.isFinite(d.priceTick) && d.priceTick > 0);
  return dist
    .filter((d) => Number.isFinite(d.priceTick) && d.priceTick > 0)
    .map((d) => ({ priceTick: 1 / d.priceTick, liquidity: d.liquidity }));
}

/** PURE: fraction of the distribution's liquidity whose priceTick sits within
 * [rangeMin, rangeMax]. Null when there's no positive liquidity to divide by. */
export function inRangeLiquidityFraction(dist: LiqBucket[], rangeMin: number, rangeMax: number): number | null {
  let total = 0;
  let inRange = 0;
  for (const d of dist) {
    if (!Number.isFinite(d.liquidity) || d.liquidity <= 0) continue;
    total += d.liquidity;
    if (d.priceTick >= rangeMin && d.priceTick <= rangeMax) inRange += d.liquidity;
  }
  if (total <= 0) return null;
  return inRange / total;
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

  // Fee model (spec10 Fix 2): grounded in the pair's real pool when its TVL and
  // per-step volume are present, else "unavailable" with 0 fees -- never a
  // number pulled from asset-level volume.
  const poolTvlUsd = input.poolTvlUsd ?? 0;
  const poolVolumePerStepUsd = input.poolVolumePerStepUsd ?? 0;
  const hasPoolData = poolTvlUsd > 0;

  let feesEarnedUsd = 0;
  let assumedPoolShareUsed = 0;
  let feeBasis: "tick" | "pool" | "unavailable" = "unavailable";

  if (hasPoolData) {
    // Concentration-aware "tick" share (spec 015): a concentrated position
    // competes only with the pool liquidity INSIDE its range, from the real
    // distribution. Attempt it first; if the distribution is absent, wrong-scale,
    // or doesn't cover the range, fall back to the spec10 "pool" heuristic.
    const currentRatio = ratios[ratios.length - 1];
    let tickShare: number | null = null;
    if (input.activeLiquidityDistribution && input.activeLiquidityDistribution.length > 0 && currentRatio !== undefined) {
      const aligned = alignDistributionOrientation(input.activeLiquidityDistribution, currentRatio);
      if (aligned) {
        const frac = inRangeLiquidityFraction(aligned, rangeMin, rangeMax);
        if (frac !== null && frac > MIN_IN_RANGE_FRACTION) {
          const poolTvlInRange = poolTvlUsd * frac;
          tickShare = Math.min(MAX_EFFECTIVE_POOL_SHARE, positionSizeUsd / (positionSizeUsd + poolTvlInRange));
        }
      }
    }

    if (tickShare !== null) {
      assumedPoolShareUsed = tickShare;
      feeBasis = "tick";
    } else {
      // spec10 "pool" heuristic: honest fraction of the whole pool, concentrated
      // by a tighter range via the 1/width factor, capped.
      const baseShare = positionSizeUsd / (poolTvlUsd + positionSizeUsd);
      assumedPoolShareUsed = Math.min(MAX_EFFECTIVE_POOL_SHARE, baseShare * concentrationFactor);
      feeBasis = "pool";
    }

    for (let i = 0; i < inRangeFlags.length; i++) {
      if (inRangeFlags[i]) {
        feesEarnedUsd += poolVolumePerStepUsd * feeTier * assumedPoolShareUsed;
      }
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
    feeBasis,
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
