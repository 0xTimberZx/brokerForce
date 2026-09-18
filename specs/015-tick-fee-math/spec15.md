# 015 — Concentration-Aware (v3) Backtest Fee Math

> **Status: DRAFT for review 2026-09-18.** Upgrades the backtester's fee estimate
> from a heuristic to a model grounded in the pair's real liquidity distribution
> (spec 012) and verified fee tier (spec 013). Builds directly on 010/012/013.

## Purpose / the gap
The current fee model (spec 010 Fix 2, `services/backtest.ts`) is honest that it's
an estimate, but the concentration benefit is a **made-up heuristic**:

```
baseShare          = positionSize / (poolTvl + positionSize)
concentrationFactor = min(50, max(1, 1 / rangeWidthPct))   // pure heuristic
effectiveShare      = min(0.5, baseShare × concentrationFactor)
fees                = Σ_{in-range} poolVolumePerStep × feeTier × effectiveShare
```

Two problems:
1. **`concentrationFactor` is invented** — "tighter range ⇒ bigger share" via `1/width`, not v3 mechanics. It has no relationship to where liquidity actually sits.
2. **The share competes against the *whole* pool TVL**, when a concentrated position only competes with the liquidity that *overlaps its range*. That's the entire economic point of v3 concentrated liquidity, and the current model misses it.

We now have the missing input: **`pools.active_liquidity_distribution`** (spec 012) — the pool's liquidity by price bucket — plus the **verified fee tier** (spec 013). That lets us replace the heuristic with the real v3 economic relationship.

## What this is (and honestly isn't)
A **full** v3 fee simulation would, per price step, compute the position's liquidity `L` from the v3 sqrt-price formulas and track the *active* liquidity as ticks are crossed, using historical per-tick liquidity state. **We can't do that faithfully:** we store only a **current snapshot** of the distribution (top-40 ticks by `liquidityGross`), not historical per-tick `liquidityNet` state over the backtest window. Claiming a tick-by-tick swap sim on that data would be false precision.

So this spec delivers the **economically correct concentration model** that our data *can* support:

> A concentrated position competes for fees only with the pool liquidity **inside its price range**. Narrow the range and you compete with less liquidity → a larger share per in-range step — but you're in range fewer steps (already modelled by time-in-range). Both sides of the real v3 trade-off, driven by the **actual** liquidity shape instead of `1/width`.

Full sqrt-tick simulation stays out of scope (needs historical tick ingestion — a separate, larger feature).

## The model
Inputs added to `runBacktest`: the pair's pool `activeLiquidityDistribution:
{priceTick, liquidity}[]` (from the chosen pool) and its current price hint.

```
totalLiq        = Σ dist.liquidity
inRangeLiq      = Σ dist.liquidity where dist.priceTick ∈ [rangeMin, rangeMax]
inRangeFraction = inRangeLiq / totalLiq
poolTvlInRange  = poolTvl × inRangeFraction
effectiveShare  = min(MAX_EFFECTIVE_POOL_SHARE, positionSize / (positionSize + poolTvlInRange))
fees            = Σ_{in-range steps} poolVolumePerStep × feeTier × effectiveShare
feeBasis        = "tick"
```

A tighter range ⇒ smaller `poolTvlInRange` ⇒ larger `effectiveShare` — the concentration reward, now proportional to how little competing liquidity sits in the band, not an arbitrary factor. Still capped at `MAX_EFFECTIVE_POOL_SHARE` (0.5).

### Orientation / units — the main correctness risk
`dist.priceTick` is the subgraph's `price0` (token0 priced in token1), where token0/token1 are ordered **by contract address**, not by the pair's `assetA/assetB`. The backtest's `rangeMin/rangeMax` are `assetA/assetB` ratio bounds. **These may be inverted or on a different scale**, which would make `inRangeFraction` garbage. The build MUST:
- Detect orientation by comparing the distribution's price magnitude to the pair's current ratio (`pricesA[last]/pricesB[last]`); if they're reciprocals, invert the distribution prices (and swap which end is min/max) before summing.
- If, after alignment, the current ratio doesn't fall within the distribution's price span at all, treat the distribution as unusable for this pair → **fall back to the spec-010 `"pool"` model** (don't emit a bogus `"tick"` estimate).
- This is the #1 thing the verification must prove on a real pool.

### Guards (fall back, never fabricate)
- No `activeLiquidityDistribution` (non-enriched pool) → **`"pool"` basis** (current model), unchanged.
- Empty/zero `totalLiq`, or `inRangeFraction` rounding to ~0 (range sits outside all stored buckets — possible because we keep only top-40 ticks) → **`"pool"` fallback**, so a sparse snapshot can't inflate the share to the 0.5 cap.
- No pool data at all → **`"unavailable"`**, fees 0 (unchanged).

## feeBasis becomes a 3-way
`BacktestResult.feeBasis: "tick" | "pool" | "unavailable"`.
- `"tick"` — concentration-aware, distribution-grounded (this spec).
- `"pool"` — spec-010 heuristic (pool has TVL/volume but no usable distribution).
- `"unavailable"` — no pool data.

## Changes
- **`services/backtest.ts`**: add `activeLiquidityDistribution` + `currentRatio` to `BacktestInput`; new pure helpers `alignDistributionOrientation(dist, currentRatio)` and `inRangeLiquidityFraction(dist, rangeMin, rangeMax)`; compute the `"tick"` share when a usable distribution is present, else fall back. Keep the spec-010 path intact for `"pool"`. Unit-test the helpers (orientation flip, in-range sum, empty/degenerate → fallback).
- **`routes/backtest.ts`**: the pool-selection query (already prefers `COALESCE(fee_tier_verified, fee_tier)`, spec 013) also selects `active_liquidity_distribution`; pass it + the current ratio into `runBacktest`.
- **`packages/types`**: `BacktestResult.feeBasis` gains `"tick"`.
- **`BacktestResultsSummary.tsx`**: when `feeBasis === "tick"`, the caption says the fee estimate is grounded in the pool's real liquidity distribution (concentration-aware), still an estimate not a guarantee; `"pool"` and `"unavailable"` copy unchanged.
- No DB migration (distribution already stored by spec 012).

## Acceptance criteria
- [ ] A backtest on an enriched v3 pair returns `feeBasis: "tick"`; a tighter range yields a higher `effectiveShare` (and per-in-range-step fee) than a wide one, because `poolTvlInRange` shrinks — verified on real distribution data.
- [ ] Orientation handled: a pool whose `price0` is the reciprocal of the pair ratio still produces a sane `inRangeFraction` (verified against a known pool).
- [ ] Distribution absent / unusable → clean fallback to `"pool"`; no pool → `"unavailable"`. No fabricated `"tick"` numbers.
- [ ] Helpers pure + unit-tested; typecheck / lint / build / suite pass.
- [ ] No ORT change (backtest doesn't feed ORT).

## Verification
Scratch DB seeded with a real enriched v3 pool (BTC/ETH-style: TVL, volume, verified fee tier, real `active_liquidity_distribution`). Run the same backtest at ±2% and ±20% ranges → assert `feeBasis:"tick"` and that the tight range's `effectiveShare` > the wide range's, with `poolTvlInRange` moving inversely. Force a reciprocal-oriented distribution → assert alignment corrects it. Drop the distribution → assert `"pool"` fallback; drop pool rows → `"unavailable"`. Screenshot the Backtester with the concentration-aware caption.

## Out of scope
- Full sqrt-price per-tick swap simulation + historical tick-liquidity ingestion (the "real" tick sim — a later, larger feature; this is the honest approximation on current data).
- Changing IL, time-in-range, or exit math (all already real).
- Windowing the distribution over 30/90/200 (it's a current snapshot, same caveat as all pool fields).
