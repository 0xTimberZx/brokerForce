# 012 — Uniswap-v3 Subgraph Enrichment (active liquidity + popularity)

> **Status: DRAFT for review 2026-07-22.** This is "Option 2" from spec 010,
> now unblocked by the clean v3 identification + validated addresses that
> spec 011 shipped. It fills the three `pools` columns that have existed since
> migration 001 but no source ever populated:
> `active_liquidity_distribution`, `swap_count_7d`, `unique_lp_count`.

## Purpose
The concentrated-liquidity (v3) story is what makes BrokerForce more than a
price charter: *where* liquidity actually sits across the tick range, and how
*busy* a pool is, are exactly what an LP needs to judge a range. Spec 010 wired
the pool figures we already had (TVL, volume, fee opportunity) and deliberately
left "Pair popularity" and "Active liquidity distribution" as **built-but-empty**
surfaces. Spec 011 gave us the two things an external join needs: a queryable
`pool_version = "v3"` cohort and a **validated on-chain `pool_address`**. This
feature is the first external enrichment: for identified v3 pools, query the
Uniswap-v3 subgraph and fill those columns.

## What already exists (so scope stays small)
Confirmed by codebase survey — the **read path is end-to-end wired, waiting on data:**
- Columns `active_liquidity_distribution` (JSONB), `swap_count_7d`, `unique_lp_count`
  exist on `pools` (migration `001_init.sql`), always NULL today.
- `RawPoolData` (`poolSource.ts`) already declares the optional fields
  `activeLiquidityDistribution?`, `swapCount7d?`, `uniqueLpCount?` — no source sets them.
- `pools` API route (`routes/pools.ts`) already SELECTs and serves all three as
  camelCase; the `Pool` type declares them; `PoolDetailPanel.tsx` already renders
  the distribution bar-chart (conditional on non-empty) and an "Active liquidity" figure.
- `pool_address` (join key, migration 009) and `pool_version` (migration 010)
  are populated on re-ingest.

**Therefore this spec must add only the WRITE side:** an enrichment step that
populates the columns, the columns into `ingest`'s upsert, env plumbing, and the
pair-level rollup + un-stubbing of the one remaining "pending pool data" string.

## Architecture — enrichment STEP, not a fallback source
A `UniswapSubgraphPoolSource` slotted into `defaultPoolSource()`'s fallback chain
would be **wrong**: that chain is first-wins/no-merge and DexScreener already wins
wholesale, so a subgraph source would never be reached — and the subgraph only
knows Uniswap-v3 pools, not the full multi-DEX universe the primary sources cover.

Instead, a **separate enrichment pass** that runs *after* `ingest-pools` (so pool
rows and their addresses already exist):

```
migrate → ingest → generate-pairs → compute-metrics → ingest-pools → enrich-pools-subgraph → compute-ort
```

`apps/ingestion/src/enrich-pools-subgraph.ts`:
1. `SELECT id, chain, pool_address FROM pools WHERE pool_version = 'v3' AND pool_address IS NOT NULL`
   — only the cohort the subgraph can answer for, keyed by the validated address.
2. Group by `chain`; each chain has its **own** v3 subgraph deployment (see below).
3. Per chain, batch pools into `pools(where: {id_in: [...addresses]})` GraphQL
   queries (many pools per request → stays inside the free-tier budget).
4. Map the response → `active_liquidity_distribution` / `swap_count_7d` /
   `unique_lp_count`, `UPDATE pools SET ... WHERE id = $poolId`.
5. Fully **degrade-safe**: no `GRAPH_API_KEY` → step logs "skipped, key absent"
   and exits 0; a chain with no known subgraph → skip that chain; a pool the
   subgraph doesn't return → leave its columns NULL. Never fails the pipeline,
   never fabricates.

### Multi-chain reality
Our v3 pools span several chains (`canonicalChain` folds them to `ethereum`,
`arbitrum`, `polygon`, `base`, `optimism`, `bsc`, …). Uniswap-v3 publishes a
**distinct subgraph deployment per chain** on The Graph decentralized network
(`gateway.thegraph.com/api/{GRAPH_API_KEY}/subgraphs/id/{DEPLOYMENT_ID}`). The
step carries a `chain → deploymentId` map; a chain absent from the map is simply
not enriched (logged). The exact deployment IDs are published in Uniswap's docs /
The Graph explorer and **must be confirmed by the discovery probe (step 1 below)**
before wiring — this spec does not hardcode unverified IDs.

## Field-by-field: honest availability
The Uniswap-v3 subgraph does not expose all three fields equally well. Scoping
each to what's real, not what's wished:

| Field | Source in v3 subgraph | Confidence | Recommendation |
|---|---|---|---|
| **`active_liquidity_distribution`** | `pool.ticks(orderBy: tickIdx)` → `tickIdx`, `liquidityGross/Net`, `price0` | **High** — the flagship, well-supported | **Ship first-class.** Bucket/cap ticks (see below). |
| **`swap_count_7d`** | `poolDayDatas(first: 7, orderBy: date, desc)` per-day tx counts, summed | **Medium** — per-day vs cumulative `txCount` semantics need probe confirmation | Ship **best-effort**; if the probe shows only cumulative counts, fall back to a clearly-labeled cumulative or defer. |
| **`unique_lp_count`** | *No reliable field.* `pool.liquidityProviderCount` exists but Uniswap's subgraph famously leaves it **0**; a true count means paginating open `positions` (expensive, imperfect). | **Low** | **DEFER** — keep column NULL, and don't advertise LP counts. (Open decision — see below.) |

### Tick distribution shaping
Raw `pool.ticks` can be thousands of entries. To fit the JSONB column's
`[{priceTick, liquidity}]` shape (already consumed by `PoolDetailPanel`) and stay
cheap: request active ticks around the current price, cap at N buckets (e.g. the
±M initialized ticks nearest `pool.tick`), and store `{priceTick: price0,
liquidity: liquidityGross}`. Exact N/M finalized after the probe shows real tick
density for our pools.

## Pair-level "popularity" rollup
`swap_count_7d` is per-pool; `LiquidityActivityPanel` shows **pair-level**. Mirror
how `poolTvl` was threaded in spec 010 Fix 3:
- `routes/pairs.ts`: add `SUM(swap_count_7d)` (and, if kept, `SUM(unique_lp_count)`)
  across the pair's pools to the parallel pool query.
- `VolumeFieldSet` (`packages/types`): add `swapCount7d: number | null`.
- `toPairMetrics`: thread it through like `poolTvl`.
- `LiquidityActivityPanel.tsx`: replace the hardcoded `pending pool data†` string
  with the real 7d swap count (or keep "pending" gracefully when NULL); rewrite
  the footnote to match what we actually ship.

## Discovery probe (implementation step 1, before any wiring)
Egress to the subgraph is blocked from the analysis container but open on GitHub
Actions runners (where `GRAPH_API_KEY` lives as a secret). A **throwaway CI probe**
(temporary job, reverted before the real PR — same pattern used for prior API
discovery) confirms, against 2–3 real v3 pool addresses of ours:
1. The correct per-chain deployment IDs resolve and answer.
2. `pool.ticks` field names + realistic tick counts (to set the cap).
3. Whether `poolDayDatas` gives per-day or cumulative tx counts (settles `swap_count_7d`).
4. That `liquidityProviderCount` is indeed 0 (settles the `unique_lp_count` defer).
Only after the probe pins these down do we finalize the query + field mapping.

## Query-budget note
Free tier ≈ 100k queries/month. Daily pipeline × batched multi-pool queries
(`id_in`) × only v3-with-address pools keeps us comfortably under budget; the step
logs the query count so we can watch it. No per-pool fan-out.

## Changes (summary)
- `apps/ingestion/src/enrich-pools-subgraph.ts` (new) + a `UniswapV3Subgraph`
  client module (GraphQL over the gateway; `GRAPH_API_KEY`/optional `GRAPH_API_URL`).
- `apps/ingestion/src/ingest-pools.ts`: add the three columns to
  `upsertPoolWithSnapshot`'s INSERT/VALUES/`ON CONFLICT` **only if** we ever set them
  from the primary sources — otherwise they're written solely by the enrich step's
  `UPDATE` (cleaner; keeps ingest single-purpose). **Decision: enrich step owns the
  UPDATE; ingest untouched.**
- `.github/workflows/ingest-pools-daily.yml`: add `enrich-pools-subgraph` to the
  ordered chain (after `ingest-pools`) and `GRAPH_API_KEY: ${{ secrets.GRAPH_API_KEY }}`.
- `apps/ingestion/package.json`: `enrich-pools-subgraph` script.
- `routes/pairs.ts` + `VolumeFieldSet` + `toPairMetrics`: pair-level `swapCount7d` rollup.
- `LiquidityActivityPanel.tsx`: un-stub "pending pool data".
- Pure helpers (tick→bucket mapping, per-day-sum) unit-tested; the network client is thin.

## Acceptance criteria
- [ ] With `GRAPH_API_KEY` set, `enrich-pools-subgraph` populates
      `active_liquidity_distribution` for identified v3 pools with valid addresses;
      `PoolDetailPanel`'s distribution chart renders real buckets.
- [ ] `swap_count_7d` populated (best-effort per probe outcome); pair-level rollup
      surfaces in `LiquidityActivityPanel` (real number, or graceful "pending" when NULL).
- [ ] Without `GRAPH_API_KEY`, the step no-ops (exit 0), pipeline unaffected, columns stay NULL.
- [ ] A v3 pool the subgraph can't answer → columns stay NULL, never fabricated.
- [ ] No ORT score change (ORT never reads these columns — regression-check a few).
- [ ] Pure mapping helpers unit-tested; typecheck / lint / build / full suite pass.

## Verification
Scratch Postgres seeded with a real v3 pool row (valid address + `pool_version='v3'`);
run `enrich-pools-subgraph` against a captured/mocked subgraph response → assert the
three columns update to expected shapes; drop the key → assert clean no-op;
screenshot `PoolDetailPanel` distribution chart + `LiquidityActivityPanel` popularity.

## Decision — `unique_lp_count` DEFERRED (settled 2026-07-22)
The subgraph does not reliably provide it (the built-in counter is left at 0; a
true count needs expensive, imprecise position pagination). **Decision: defer.**
The `unique_lp_count` column stays NULL, "popularity" is scoped to **swap
activity** (trading busy-ness), and the UI is worded as trading activity — never
implying an LP-count we don't measure. Approximating it via position pagination
is out of scope for this feature; revisit only if a strong need appears.

## Out of scope (still later)
- v3 tick-level **fee math** in the backtest (this is distribution *display*, not
  a fee-model rewrite).
- Windowed pool history (30/90/200) for these fields.
- Non-Uniswap DEX enrichment (Sushi/Pancake v3 have their own subgraphs — same
  pattern, later).
