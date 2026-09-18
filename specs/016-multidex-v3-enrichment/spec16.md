# 016 — Multi-DEX v3 Subgraph Enrichment (Avalanche + BSC)

> **Status: Probe-verified 2026-09-18.** Extends spec 012's Uniswap-v3 enrichment
> by routing subgraph selection on **(chain, dex)** instead of chain alone, so the
> Uniswap-v3-*fork* DEXs on a chain (PancakeSwap v3, native Uniswap v3 on other
> chains) enrich through the same client. This is exactly the "Non-Uniswap DEX
> enrichment … same pattern, later" spec 012 listed as out of scope.
>
> **What actually ships (after the CI probe below): BSC.** PancakeSwap v3 on BSC is
> probe-confirmed (17 pools), and the broadened selection unblocks the 19 untagged
> `bsc:uniswap` pools through the already-mapped BSC deployment. **Avalanche is
> deferred** — the probe showed the only Avalanche Uniswap-v3 subgraph on the
> network uses a Messari schema our query can't use, and its tick cohort is tiny
> (see "Discovery-probe results"). **Solana is deferred** to its own spec — it
> cannot reuse this path at all (see "Why Solana is separate").

## Discovery-probe results (verified 2026-09-18 on a CI runner)
A throwaway push-triggered probe (`apps/ingestion/src/probe-subgraph.ts`, reverted
before merge) hit the gateway with the real `GRAPH_API_KEY`, one real DB pool
address per candidate:

| candidate | deployment | result |
|---|---|---|
| `bsc:pancakeswap` | `Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ` | **OK** — feeTier + 40 ticks + per-day poolDayDatas (swapCount7d=42554). **Full schema parity → shipped.** |
| `bsc:uniswap` (re-confirm) | `F85MN…RZTw2` (existing) | **OK** — feeTier=0.003 + ticks + swapCount7d=13354 on an untagged (`pool_version=NULL`) pool → the broadened selection will enrich the BSC uniswap pools. |
| `avalanche:uniswap` | `3Pwd3cqFKbqKAy…MxebD` | **FAIL** — `Type Query has no field pool; …poolDayDatas`. Messari-standardised schema, not Uniswap-v3. **Deferred.** |
| `bsc:pancakeswap` alt | `78EUqzJmEVJs…ZmgJ` | FAIL (wrong schema) — not needed, primary works. |

PancakeSwap v3's subgraph is a Uniswap-v3 fork, so `pool { tick feeTier ticks {
tickIdx liquidityGross price0 } }` + top-level `poolDayDatas(where:{pool}) { txCount
}` apply unchanged (parity confirmed above). Avalanche has no Uniswap-v3-schema
deployment on the network; its enrichable cohort is only ~4 small pools anyway (2
uniswap + 2 pharaoh — the chain's volume is Trader-Joe Liquidity-Book *bins*, which
no v3 subgraph expresses), so it waits for either a correct deployment or a
Messari-schema adapter (its own effort).

## Motivation — the network blind spot, measured
A 14-day fee-generation read (2026-09-18) showed enrichment-derived fee estimates
exist **only where the subgraph has run**:

| Chain | Pools | Enriched | 14d volume | Est. 14d fees |
|---|---|---|---|---|
| ethereum | 101 | 37 | $1.40B | **$337k** |
| base | 31 | 10 | $104M | $9.6k |
| **avalanche** | 20 | **0** | **$590M** | **$0 (blind)** |
| **bsc** | 145 | **0** | **$441M** | **$0 (blind)** |
| solana | 102 | 0 | $518M | $0 (separate effort) |

Avalanche/BSC show $0 **only because `fee_tier_verified` is NULL** there (fee_tier
sits at the `0` UNKNOWN sentinel, so `volume × COALESCE(fee_tier_verified, fee_tier)`
= 0), not because they're unprofitable. Over $1B of 14-day volume is unscored.

## Root-cause of the two chains' zero coverage (from a DB survey, 2026-09-18)
Enrichment today runs `WHERE pool_version = 'v3'` and routes by **chain only**
(`V3_SUBGRAPH_IDS[chain]`). Against our actual pools:

- **BSC — two distinct gaps:**
  - `dex = uniswap` pools (23; 19 with addresses) are **`pool_version = NULL`, not
    `'v3'`** — so the `pool_version='v3'` filter skips them *even though BSC's
    Uniswap-v3 subgraph is already mapped*. This is an identification gap, not a
    routing gap.
  - `dex = pancakeswap`, `pool_version = 'v3'` (17 pools, all with addresses) —
    correctly tagged v3, but chain-only routing points BSC at the **Uniswap**-v3
    subgraph, which does not know PancakeSwap pools → returns null → no enrichment.
    (`sushiswap` v3 = 1, `squadswap` v3 = 1 are the same shape, smaller.)
- **Avalanche — thin but real tick cohort:** `pharaoh` v3 (2, addresses) and
  `uniswap` (2, `pool_version = NULL`). The rest (Trader Joe = Liquidity Book
  *bins* not ticks; Pangolin/Sushi/etc. = v2 constant-product) are **not
  tick-based and out of scope** — a v3 subgraph has nothing to say about them.

## Design — route by (chain, dex); trust the subgraph over our version tag

### 1. `(chain, dex) → deployment` routing (replaces chain-only)
`V3_SUBGRAPH_IDS` becomes keyed by a `${chain}:${dex}` string. Existing entries are
re-expressed as `<chain>:uniswap` (behaviour-preserving), plus the new deployments:

| key | DEX / chain | deployment ID | status |
|---|---|---|---|
| `ethereum:uniswap` | Uniswap v3 | `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` | live (spec 012) |
| `arbitrum:uniswap` | Uniswap v3 | `FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM` | live |
| `polygon:uniswap` | Uniswap v3 | `3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm` | live |
| `base:uniswap` | Uniswap v3 | `43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG` | live |
| `bsc:uniswap` | Uniswap v3 | `F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2` | live (unblocked by §2) |
| **`bsc:pancakeswap`** | PancakeSwap v3 | `Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ` | **probe-confirmed → shipped** |
| ~~`avalanche:uniswap`~~ | Uniswap v3 | ~~`3Pwd…MxebD`~~ | **deferred — Messari schema (probe fail)** |
| ~~`avalanche:pharaoh`~~ | Pharaoh (Ramses CL) | *none found* | **deferred — no deployment + schema risk** |

A `(chain, dex)` absent from the map is simply not enriched (logged), exactly how
optimism and every non-tick DEX degrade today. `UniswapV3Subgraph.forChain(chain,
…)` becomes `forChainDex(chain, dex, …)`.

**Fork-schema parity:** PancakeSwap v3 is a direct fork of Uniswap v3 and its
subgraph is forked from Uniswap's `v3-subgraph`, so `pool { tick feeTier ticks {
tickIdx liquidityGross price0 } }` + top-level `poolDayDatas(where:{pool}) { txCount
}` apply unchanged; `feeTier` is the same integer-millionths encoding (100/500/
2500/10000). Pharaoh (Ramses) is a v3-derived CL AMM whose schema *may* differ.
**The probe validates entity/field parity per new deployment before it enters the
map.** Any deployment whose schema doesn't match is omitted — and even if one
slipped in, `enrichPool` throws on a GraphQL error → caught → `failed++`, never a
pipeline break and never fabricated data (the existing degrade-safe path).

### 2. Broaden selection; let the subgraph be authoritative on "is it v3"
Selection changes from `pool_version = 'v3'` to include untagged pools on mapped
DEXs:

```sql
SELECT id, chain, dex, pool_address, pool_version
  FROM pools
 WHERE pool_address IS NOT NULL
   AND (pool_version = 'v3' OR pool_version IS NULL)
 ORDER BY chain, dex
```

`clientFor(chain, dex)` returns null for any unmapped `(chain, dex)` → that pool is
skipped (the existing `skippedChain` path). So the query is naturally scoped to
mapped DEXs; explicitly-non-v3 rows (`pool_version = 'v2'` etc.) are excluded up
front to avoid guaranteed-miss queries. A `NULL`-version row that the subgraph
*doesn't* know (e.g. a v2 uniswap pool) returns null → `unknownPool`, one wasted
query, columns stay NULL — honest and bounded.

**Confirm v3 from the subgraph.** When the subgraph *does* return a pool for a
`NULL`-version row, it is authoritatively a v3(-schema) pool, so the enrich UPDATE
also sets `pool_version = 'v3'`:

```sql
UPDATE pools
   SET swap_count_7d = $1,
       active_liquidity_distribution = $2::jsonb,
       fee_tier_verified = $3,
       pool_version = 'v3',
       updated_at = now()
 WHERE id = $4
```

This progressively fixes the identification gap without touching the pool identity
key (`pair_id, dex, chain, fee_tier` — `pool_version` is not part of it) and without
touching ingest. `pool_version` is set **only** inside the `result` branch (a pool
the subgraph actually returned); the no-result branch leaves everything NULL. If a
later `ingest-pools` run re-nulls the version, enrichment (which runs *after* ingest
in the same pipeline) re-confirms it that same run — self-healing given step order.

### 3. Nothing else moves
No migration (all columns exist). No new env. No read-path change — `routes/pools`,
`routes/pairs`, `routes/ort`, `routes/backtest`, `PoolDetailPanel`,
`TopOpportunitiesPanel` already consume `fee_tier_verified` /
`active_liquidity_distribution` / `swap_count_7d` generically; more rows populated
is strictly more data through the same wires. ORT never reads these columns
(regression-check unchanged).

## Why Solana is separate (deferred, per scope decision 2026-09-18)
Solana has no EVM and nothing on The Graph gateway; `UniswapV3Subgraph` cannot be
reused. Its 102 pools split into: `orca` Whirlpools (18 — tick-based, the clean
analog), `raydium` (27 — mixed CLMM + constant-product), `meteora` DLMM (23 —
bin-based, needs a translation layer), and `pumpfun`/`fluxbeam`/`pumpswap`/
`meteoradbc` (34 — bonding curves / constant-product with **no concentrated
liquidity to fetch at all**). Each CLMM DEX needs its own REST client and
liquidity-model mapping into `[{priceTick, liquidity}]`. That is a whole spec
(Orca-first), tracked separately — not folded here.

## Discovery probe (GATING — mirrors spec 012)
Egress to the gateway is blocked from the analysis container but open on GitHub
Actions runners, where `GRAPH_API_KEY` lives as a repo secret. A throwaway,
`workflow_dispatch`-triggered probe (reverted before this feature merges) must, for
each **candidate** deployment above:
1. Resolve on `gateway.thegraph.com/api/{key}/subgraphs/id/{ID}` (healthy indexers,
   no `bad indexers` error).
2. Return a real `pool(id: <a real address from our DB on that chain/dex>)` with
   `tick`, `feeTier`, and `ticks { tickIdx liquidityGross price0 }`.
3. Return top-level `poolDayDatas(first: 7, where: {pool: <addr>}) { txCount }` as
   **per-day** counts (spec 012's parity check).

Candidate IDs found by web search (Graph Explorer), **unconfirmed until the probe
runs**: `avalanche:uniswap` = `3Pwd3cqFKbqKAyaJfGUVmJJ7oYbFQLDa19iB27iMxebD`;
`bsc:pancakeswap` = `Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ` (exchange-v3-bsc);
`avalanche:pharaoh` = to locate on Explorer. Any candidate that fails 1–3 is
**omitted from v1** (logged), never guessed into the map.

## Query-budget note
Free tier ≈ 100k queries/month. Broadening to `v3 OR NULL` on mapped DEXs adds at
most the untagged-uniswap + fork cohorts (order 10²) per daily run; ≪ budget. The
step already logs `queries` issued — watch it after the first live run.

## Changes (summary)
- `apps/ingestion/src/sources/uniswapV3Subgraph.ts`: key `V3_SUBGRAPH_IDS` by
  `${chain}:${dex}`; `forChain` → `forChainDex(chain, dex, …)`; add a pure
  `subgraphKey(chain, dex)` helper (unit-tested). Query + mapping helpers unchanged
  (schema parity is the fork's contract).
- `apps/ingestion/src/enrich-pools-subgraph.ts`: broadened SELECT (adds `dex`,
  `pool_version`, `v3 OR NULL`); `clientFor(chain, dex)`; UPDATE also sets
  `pool_version = 'v3'` in the result branch; per-`(chain,dex)` skip logging.
- `apps/ingestion/src/probe-subgraph.ts` (new, throwaway) + a `workflow_dispatch`
  probe job — reverted before merge.
- Tests: `subgraphKey` + `forChainDex` routing (mapped/unmapped, fork keys); an
  `enrich` selection/UPDATE test asserting a NULL-version mapped-DEX pool is
  attempted and, on a mocked hit, gets `pool_version='v3'` + the three columns; a
  non-tick DEX / unmapped `(chain,dex)` is skipped.

## Acceptance criteria
- [x] Probe confirms `bsc:pancakeswap` (schema parity + healthy) and re-confirms
      `bsc:uniswap` resolves untagged pools. `avalanche:uniswap` failed (Messari
      schema) → deferred, not shipped; Pharaoh deferred (no deployment).
- [ ] After a live pipeline run, **`bsc` shows > 0 enriched pools** with
      `fee_tier_verified` populated; the 14-day per-chain fee read is no longer $0
      for BSC. (Avalanche stays $0 until its deployment is sorted — documented.)
- [ ] BSC `dex=uniswap` `NULL`-version pools that the subgraph knows get
      `pool_version='v3'` + enriched columns; ones it doesn't know stay NULL.
- [x] `pool_version` set only on a real subgraph hit; pool identity key untouched;
      ingest untouched.
- [x] No `GRAPH_API_KEY` → step no-ops (exit 0), pipeline unaffected (unchanged).
- [x] No ORT score change (ORT never reads these columns); existing enriched chains
      (eth/base/…) unchanged.
- [x] Pure helpers unit-tested; typecheck / lint / build / full suite pass.

## Verification
Unit tests as above (pure routing + selection/UPDATE logic). Scratch-Postgres e2e
seeds AVAX/BSC pool rows (real addresses, one `pool_version=NULL` uniswap, one
`pancakeswap v3`) and runs `enrich-pools-subgraph` against mocked subgraph responses
→ assert the mapped rows update (incl. `pool_version='v3'` on the NULL row) and an
unmapped-DEX row is skipped; drop the key → clean no-op. Live confirmation via a
`workflow_dispatch` pipeline run, then re-query per-chain enriched counts + the
14-day fee read (the numbers in "Motivation" should move off $0 for AVAX/BSC).

## Out of scope (still later)
- **Solana enrichment** (Orca-first) — its own spec.
- Algebra-schema CL DEXs whose subgraph is *not* Uniswap-v3-compatible (e.g. Thena
  on BSC) — a different query, later.
- Upstream fix to `ingest-pools` v3 identification (this spec self-heals via the
  subgraph instead).
- Windowed pool history for these fields.
