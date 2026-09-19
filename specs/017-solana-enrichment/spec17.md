# 017 — Solana CLMM Enrichment (Orca first, then Raydium)

> **Status: Drafted 2026-09-19.** Closes the last big enrichment blind spot —
> **Solana** — which spec 016 explicitly deferred because it *cannot* reuse the
> subgraph path (no EVM, nothing on The Graph gateway). Solana concentrated-liquidity
> DEXs are read over their own **REST APIs** (Orca v2, Raydium api-v3), with the
> per-tick distribution living **on-chain** (a heavier, later phase). Orca ships
> first; Raydium follows in the same step behind a per-DEX client.

## Motivation — the last dark chain
The 14-day per-chain fee read (2026-09-18, post-spec-016) — BSC now lit, Solana still $0:

| Chain | Enriched | 14d volume | 14d est. fees |
|---|---|---|---|
| bsc | 25 | $441M | $1,201,109 ✅ (spec 016) |
| ethereum | 38 | $1.40B | $510,503 |
| **solana** | **0** | **$518M** | **$0 (blind)** |
| avalanche | 0 | $590M | $0 (no v3-schema subgraph) |

Solana is $0 for the *same* reason BSC was: every Solana pool sits at the
`fee_tier = 0` UNKNOWN sentinel with `fee_tier_verified = NULL`, so `volume ×
COALESCE(fee_tier_verified, fee_tier)` collapses to zero — not because the volume
isn't real. Our own Orca rows (all `fee_tier=0`, `fee_tier_verified=NULL`,
`pool_version=NULL`, no distribution) include serious pools:

| Orca pool (pair) | TVL | 24h volume |
|---|---|---|
| ETH/SOL | $7.3M | **$21.4M** |
| USDC/ZEC | $2.2M | $17.7M |
| SOL/ZEC | $2.2M | $13.4M |
| USDT/XRP | $11.0M | $0.17M |
| BTC/SOL | $1.2M | $6.6M |

18 Orca pools (16 with a `pool_address` = the Whirlpool pubkey), 27 Raydium
(mixed CLMM + AMM-v4), 23 Meteora (bin DLMM — *not* this spec). Enriching just
Orca + Raydium fee tiers should surface a large slice of that $518M as measured
fees, exactly as spec 016 did for BSC.

## Why Solana can't reuse spec 012/016 (the subgraph path)
- No EVM, no Uniswap-v3 schema, nothing on `gateway.thegraph.com`.
- Each DEX has its **own REST API** with its own field names + fee encoding, and
  the **per-tick liquidity distribution is on-chain** (TickArray accounts), not in
  the REST response — reading it needs a Solana RPC + account decoding (SDK), a
  materially bigger lift than a GraphQL `pool.ticks` field.

So this is a **new enrichment step** (`enrich-pools-solana.ts`), sibling to
`enrich-pools-subgraph.ts`, with a per-DEX client under `sources/`. It never
touches the subgraph step.

## What each source actually exposes (from API research; probe-confirmed before merge)
| Field | Orca v2 (`api.orca.so/v2/solana/pools/{addr}`) | Raydium (`api-v3.raydium.io`) |
|---|---|---|
| **fee rate** | `feeRate` — hundredths of a bps (100 = 0.01% = 1 bp) → **`/1_000_000` = fractional**, the *same* encoding as Uniswap's `feeTier` (reuse `feeTierToFractional`) | `ammConfig.tradeFeeRate` (CLMM) / config feeRate — same millionths encoding (probe-confirm) |
| pool type | Whirlpool (always CLMM) | **mixed** — CLMM vs AMM-v4 (constant-product) vs CPMM; the API reports the type per pool |
| tick geometry | `tickSpacing`, `tickCurrentIndex`, `sqrtPrice`, aggregate `liquidity` (one number, current active liquidity — **not** per-tick) | analogous PoolState fields; per-tick in TickArrayState (on-chain) |
| TVL / price | `tvlUsdc`, `price` (already covered by our primary source) | present |
| per-tick distribution | **on-chain only** (TickArray accounts, 88 ticks each) | **on-chain only** (TickArrayState) |

**Key consequence:** `fee_tier_verified` is a cheap REST field (Phase 1, the whole
fee win); `active_liquidity_distribution` needs on-chain reads (Phase 2).

## Phased design

### Phase 1 — fee tiers over REST (this spec's ship target)
`apps/ingestion/src/enrich-pools-solana.ts`, run after `ingest-pools` (rows +
addresses exist), alongside the subgraph step:

```
… → ingest-pools → enrich-pools-subgraph → enrich-pools-solana → compute-ort
```

1. `SELECT id, dex, pool_address FROM pools WHERE chain='solana' AND dex IN
   ('orca','raydium') AND pool_address IS NOT NULL`.
2. Per pool, route by `dex` to its REST client (`OrcaWhirlpools` / `RaydiumClmm`),
   fetch by `pool_address`, read the fee rate → fractional.
3. **Raydium pool-type gate:** the API says whether a pool is CLMM or AMM-v4/CPMM.
   - CLMM → concentrated; set `fee_tier_verified` + `pool_version='clmm'`.
   - AMM-v4 / CPMM → constant-product; set `fee_tier_verified` (its flat fee) but
     **not** `pool_version` (it isn't concentrated). Honest either way.
   Orca Whirlpools are always CLMM.
4. `UPDATE pools SET fee_tier_verified = $1, pool_version = $2, updated_at = now()
   WHERE id = $3` (pool_version only for CLMM). **Additive** — never touches the
   identity key (`pair_id, dex, chain, fee_tier`) or ingest.
5. **Degrade-safe** (mirrors the subgraph step): no reachability / unknown pool /
   API error → leave columns NULL, count + skip, never fail the pipeline, never
   fabricate. Public REST needs no secret, but a per-pool throttle + timeout apply;
   the step logs query + outcome counts.

**Decision — `pool_version='clmm'` (not `'v3'`).** Orca/Raydium CL pools are
genuinely concentrated but are *not* Uniswap v3, so overloading `'v3'` would be
dishonest and would tangle them with the subgraph step's `v3 OR NULL` selection.
`'clmm'` is additive (not in the identity key) and keeps them clearly distinct. The
tick-basis backtest keys on the *distribution* (Phase 2), not the version string,
and the 14-day fee read is version-agnostic (`COALESCE(fee_tier_verified,
fee_tier)`) — so Phase 1 lights Solana fees up on its own. (Open question for
review: whether any consumer should treat `'clmm'` like `'v3'` for display.)

### Phase 2 — active liquidity distribution over on-chain reads (scoped, deferred)
Populate `active_liquidity_distribution` (the concentration model's input, spec
015) by decoding on-chain tick arrays via a Solana RPC (`SOLANA_RPC_URL`):
- Orca: read the Whirlpool's initialised `TickArray` accounts around
  `tickCurrentIndex`, map each initialised tick's net liquidity → the existing
  `[{priceTick, liquidity}]` shape (price from the tick index + token decimals),
  reuse `ticksToDistribution`'s top-N-by-liquidity shaping.
- Raydium CLMM: same idea over `TickArrayState`.
Needs the `@orca-so/whirlpools`/`@raydium-io` SDKs (or raw account layouts) + an
RPC endpoint and careful decimal→price math; it is its own PR. Until it lands,
Solana CLMM pools get `feeBasis:"pool"` in the backtest (real fee tier, whole-pool
share) — strictly better than today's `"unavailable"`.

## Discovery probe (GATING — mirrors spec 012/016)
Throwaway probe (`apps/ingestion/src/probe-solana.ts`, reverted before merge),
one real DB pool address per DEX, confirming before any ID/encoding is trusted:
1. Orca `GET api.orca.so/v2/solana/pools/{whirlpool}` resolves and returns
   `feeRate` (+ `tickSpacing`, `tickCurrentIndex`); assert `feeRate/1e6` gives a
   sane tier (e.g. 0.0001–0.01).
2. Raydium `GET api-v3.raydium.io/pools/info/ids?ids={id}` resolves, reports the
   pool **type**, and exposes the CLMM `tradeFeeRate` encoding.
3. Reachability from the CI runner (the daily pipeline's environment).
Any source that fails is omitted from Phase 1 (logged), never guessed — same
discipline that omitted Avalanche in spec 016.

## Changes (summary — Phase 1)
- `apps/ingestion/src/sources/orcaWhirlpools.ts` (new): thin REST client + pure
  `feeRateToFractional` (reuse/extend `feeTierToFractional`) + response mapper.
- `apps/ingestion/src/sources/raydiumClmm.ts` (new): REST client + pure pool-type
  classifier + fee mapper.
- `apps/ingestion/src/enrich-pools-solana.ts` (new): the step (routing, broadened
  Solana selection, CLMM-gated `pool_version`, degrade-safe).
- `apps/ingestion/package.json`: `enrich-pools-solana` script.
- `.github/workflows/ingest-pools-daily.yml`: add the step after
  `enrich-pools-subgraph`; optional `SOLANA_RPC_URL` plumbed now for Phase 2.
- Pure helpers (fee encoding, Raydium type classifier, mapper) unit-tested; the
  network clients stay thin.

## Acceptance criteria (Phase 1)
- [ ] Probe confirms Orca v2 + Raydium api-v3 fee encoding against real pool
      addresses; unreachable/unsupported source omitted + logged.
- [ ] After a live pipeline run, **Solana shows > 0 pools with
      `fee_tier_verified`** (Orca + Raydium-CLMM), and the 14-day per-chain fee
      read is **no longer $0** for Solana.
- [ ] Orca/Raydium-CLMM pools get `pool_version='clmm'`; Raydium AMM-v4/CPMM get
      `fee_tier_verified` but not `pool_version`; Meteora untouched.
- [ ] `fee_tier_verified`/`pool_version` set only on a real API hit; pool identity
      key untouched; ingest untouched.
- [ ] Step is degrade-safe: any API failure leaves columns NULL, pipeline
      unaffected; no ORT score change (ORT never reads these columns).
- [ ] Pure helpers unit-tested; typecheck / lint / build / full suite pass.

## Verification
Unit tests for the pure helpers (fee encoding, Raydium CLMM/AMM classifier,
response mapper). Scratch-Postgres e2e: seed Solana Orca + Raydium rows (real
addresses) and run `enrich-pools-solana` against mocked REST responses → assert
`fee_tier_verified` + CLMM-gated `pool_version` update, a Meteora row is skipped,
and an API-error pool stays NULL. Live confirmation via a `workflow_dispatch`
pipeline run, then re-query Solana enriched counts + the 14-day fee read (should
move off $0), same as spec 016's BSC confirmation.

## Out of scope
- **Phase 2** on-chain tick-distribution decoding (its own PR, scoped above).
- **Meteora DLMM** (bin-based, not tick/CLMM — a different model + math).
- Bonding-curve / constant-product-only DEXs with no fee-tier concept worth
  verifying (pump.fun, fluxbeam, pumpswap, meteoradbc) — left at the `fee_tier`
  sentinel; DexScreener's flat fee, if any, is not a concentrated-liquidity signal.
- `swap_count_7d` for Solana (REST may not expose a clean 7d per-day count;
  best-effort later if a source does).
