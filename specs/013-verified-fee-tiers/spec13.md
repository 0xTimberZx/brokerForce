# 013 — Verified Fee Tiers from the Subgraph

> **Status: DRAFT for review 2026-07-22.** A small, additive extension of spec
> 012's enrichment step that closes the most visible gap in the product: real
> pool fee tiers, so **Fee opportunity** stops reading `$0/day`.

## Purpose / the gap
`pools.fee_tier` is the `0 = UNKNOWN` sentinel for the bulk of rows, because the
primary source (DexScreener) doesn't reliably report a fee tier — its labels are
version tags (`["v3"]`), not fees. Everything downstream that multiplies by
`fee_tier` therefore collapses to zero:

- `pair_metrics.fee_opportunity = Σ (volume × fee_tier)` → **$0/day** (the
  "Fee opportunity" line the UI shows).
- `pair_metrics.fee_opportunity_score = grossDailyFees / poolTvl` → **0**.
- The backtester's pool selection (`ORDER BY (fee_tier = $2) DESC, tvl DESC`)
  can't match a pool by fee tier, so it always falls back to highest-TVL.

Confirmed on live prod data (2026-07-22 run): **all 23 subgraph-enriched v3 pools
have `fee_tier = 0`**, so BTC/SOL, AAVE/USDC, etc. all show Fee opportunity $0.

**The fix is already in reach.** The Uniswap-v3 subgraph exposes `pool.feeTier`,
and `enrich-pools-subgraph` (spec 012) *already queries that pool by address*.
Capturing `feeTier` in the same request gives us the real fee tier for every
enriched v3 pool at ~zero extra cost (no new query).

## Key design decision — a NEW column, NOT an in-place `fee_tier` update
`fee_tier` is part of the pool identity key
`pools_pair_dex_chain_fee_unique (pair_id, dex, chain, fee_tier)` (migration 002).
Updating it in place from `0` → `0.0005` would risk a **unique-key collision**
(if a `(pair_id, dex, chain, 0.0005)` row already exists) and mutate a pool's
identity mid-life. Converging fee tier *into* the identity key is real,
separate work (deferred in specs 011/012) and out of scope here.

Instead, this feature is **purely additive**: a new nullable column
`pools.fee_tier_verified` (fractional, same unit as `fee_tier`) holds the
subgraph-sourced tier. The identity key, `fee_tier`, and the uniqueness
constraint are **untouched**. Consumers prefer the verified value when present:
`COALESCE(fee_tier_verified, fee_tier)`. This sidesteps all identity churn and
is trivially reversible.

## Unit
The subgraph's `pool.feeTier` is an integer in millionths (probe-confirmed:
`500`, `3000`, `10000`). Fractional = `feeTier / 1_000_000` (500 → 0.0005,
3000 → 0.003, 10000 → 0.01) — exactly matching the fractional convention
`fee_tier` already uses (`parsePoolName`: "0.3%" → 0.003). Stored fractional so
**no consumer needs a unit conversion**; `COALESCE(fee_tier_verified, fee_tier)`
is directly usable in `Σ volume × fee`.

## Changes

### Migration `013_pool_fee_tier_verified.sql`
```sql
ALTER TABLE pools ADD COLUMN IF NOT EXISTS fee_tier_verified NUMERIC;
```
Nullable; NULL means "not verified from the subgraph" (non-Uniswap pools,
non-v3 pools, pools the subgraph doesn't index) → consumers fall back to
`fee_tier`.

### Subgraph client (`uniswapV3Subgraph.ts`)
- Add `feeTier` to `POOL_ENRICH_QUERY`'s `pool { … }` selection.
- `SubgraphPoolResult` gains `feeTierFractional: number | null`.
- A pure helper `feeTierToFractional(raw): number | null` — `Number(raw)/1e6`,
  guarding non-finite / ≤ 0 → null. Unit-tested (500 → 0.0005, etc.).
- `enrichPool` returns it alongside `swapCount7d` / `activeLiquidityDistribution`.

### Enrichment step (`enrich-pools-subgraph.ts`)
- Add `fee_tier_verified` to the `UPDATE pools SET …` (only the enrich step
  writes it). NULL result → leave NULL, never fabricate. Same degrade-safe
  rules as spec 012.

### Pair-engine (`apps/pair-engine/src/db.ts` `fetchPoolAggregates`)
- `SUM(volume * fee_tier)` → **`SUM(volume * COALESCE(fee_tier_verified, fee_tier))`**.
  This is the line that makes `fee_opportunity` real. No other metric changes.

### Backtest route (`apps/api/src/routes/backtest.ts`)
- Pool selection `ORDER BY (fee_tier = $2) DESC, tvl DESC`
  → `ORDER BY (COALESCE(fee_tier_verified, fee_tier) = $2) DESC, tvl DESC`,
  so a pool can be matched to the chosen tier once it's verified. (The fee
  *math* already uses the caller's `feeTier`; this only improves which pool's
  TVL/volume anchors the estimate.)

### UI
No structural change — `FeeILPreview` and the backtest summary already render
`feeOpportunity` / the fee figure; they simply stop showing `$0` once real
tiers flow. Optionally soften any "fee tier unknown" copy, but not required.

## Pipeline-ordering note (1-cycle lag, self-healing)
Current order: `… compute-metrics → ingest-pools → enrich-pools-subgraph → compute-ort`.
`compute-metrics` runs **before** enrichment, so a given day's
`fee_opportunity` reflects the *previous* run's `fee_tier_verified`. After the
first enrichment run has populated the column, the next `compute-metrics`
computes real fees — a one-run delay that self-heals, consistent with spec 010's
"pool fields reflect the latest snapshot, refreshed daily" model. The
**backtester reads `pools` live**, so it benefits immediately once enrichment
has run once. (Reordering `compute-metrics` after enrichment is possible but not
needed for v1 and risks other sequencing; left as an optional later tidy.)

## Acceptance criteria
- [ ] `pools.fee_tier_verified` populates for subgraph-enriched v3 pools; NULL
      for everything else. Identity key + `fee_tier` unchanged.
- [ ] `feeTierToFractional` unit-tested (500→0.0005, 3000→0.003, 10000→0.01,
      0/garbage→null).
- [ ] `fetchPoolAggregates` uses `COALESCE(fee_tier_verified, fee_tier)`;
      `fee_opportunity` / `fee_opportunity_score` become non-zero for a pair
      with a verified-tier pool (NULL, not 0, when a pair has no pools).
- [ ] Backtest on a pair with a verified-tier pool selects the tier-matched pool;
      `feeBasis: "pool"` with a realistic fee.
- [ ] No ORT score change (ORT reads none of these fields — regression-check).
- [ ] typecheck / lint / build / full suite pass.

## Verification
Scratch Postgres seeded with a v3 pool (`fee_tier = 0`, valid address). Run
`enrich-pools-subgraph` against a mocked subgraph returning `feeTier: 500` →
assert `fee_tier_verified = 0.0005`. Run `compute-metrics` → assert
`fee_opportunity = Σ volume × 0.0005` (non-zero) and `fee_opportunity_score`
non-zero. POST `/backtest` → assert the tier-matched pool anchors the estimate,
`feeBasis: "pool"`. Drop the verified value → assert clean fallback to the
`fee_tier` sentinel (fees 0), no crash.

## Out of scope (unchanged from 011/012)
- Folding fee tier into the pools identity key + converging stale rows.
- Non-Uniswap DEX fee tiers (Sushi/Pancake v3 — their own subgraphs).
- Making `fee_tier` itself nullable / retiring the `0` sentinel.
- v3 tick-level fee math in the backtest (this is the *tier*, not the model).
