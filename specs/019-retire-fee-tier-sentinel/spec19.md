# 019 — Retire the `fee_tier = 0` Sentinel (single authoritative fee)

> **Status: Drafted 2026-09-19.** Now that spec 018 made pool identity
> address-based, `fee_tier` is no longer part of the identity key — so it can hold
> the *real* fee, and the `fee_tier_verified` shadow column (spec 013, added
> precisely to avoid mutating the identity key) can be folded back in. Collapse to
> **one authoritative `fee_tier`** where **NULL = genuinely unknown**, retiring the
> ambiguous `0` sentinel and the `COALESCE(fee_tier_verified, fee_tier)` pattern.

## Why now
- **Spec 013 rationale is obsolete.** `fee_tier_verified` existed only because
  `fee_tier` was an identity-key column that couldn't be mutated in place. Spec 018
  removed `fee_tier` from the identity (identity is `(chain, pool_address)`), so
  that constraint is gone.
- **The `0` sentinel is ambiguous and lossy.** `0` means "unknown," but it's
  indistinguishable from a real 0% fee, and it silently zeroes `fee_opportunity`
  (`Σ volume × fee_tier`). NULL says "unknown" honestly and drops out of the sum.
- **The data says the sentinel is the norm, not the exception:** 891 of 931 pools
  (96%) sit at `fee_tier = 0`; enrichment (`fee_tier_verified`, 255 rows) is the
  de-facto real fee source. The two-column COALESCE dance is paid on every read
  for a column that's almost always the sentinel.

## End state
- **One column, `fee_tier NUMERIC` (nullable):** the real fractional fee
  (`0.003` = 0.3%), or **NULL** when we genuinely don't know it. No `0` sentinel.
- **`fee_tier_verified` dropped.** The API never exposed it (routes already serve
  `COALESCE(...) AS fee_tier`), so **no `packages/types` or `apps/web` change** —
  this is DB + ingestion + API-query internal only.
- Readers drop `COALESCE(fee_tier_verified, fee_tier)` → read `fee_tier` directly.

## The one subtlety — address-less unique index + NULL
Spec 018's address-less identity index is `UNIQUE (pair_id, dex, chain, fee_tier)
WHERE pool_address IS NULL`. Postgres treats NULLs as **distinct** in a unique
index by default, so NULLing `fee_tier` would let two address-less pools with the
same `(pair, dex, chain)` and NULL fee **both** insert — reintroducing duplicates
(151 address-less pools are at `fee_tier=0` today and would become NULL). PG **17.6**
(confirmed on prod) supports **`UNIQUE NULLS NOT DISTINCT`**, so the index is
recreated with that clause and NULL fee_tiers dedupe correctly.

## Migration `015_retire_fee_tier_sentinel.sql`
1. `ALTER TABLE pools ALTER COLUMN fee_tier DROP NOT NULL;`
2. Backfill authoritative value:
   `UPDATE pools SET fee_tier = COALESCE(fee_tier_verified, NULLIF(fee_tier, 0));`
   — verified where present, else the source fee if non-zero, else NULL.
3. `ALTER TABLE pools DROP COLUMN fee_tier_verified;`
4. Recreate the address-less index with NULL-dedupe:
   `DROP INDEX pools_pair_dex_chain_fee_addrless_uniq;`
   `CREATE UNIQUE INDEX pools_pair_dex_chain_fee_addrless_uniq
      ON pools (pair_id, dex, chain, fee_tier) NULLS NOT DISTINCT
      WHERE pool_address IS NULL;`
   (The address-bearing index `(chain, pool_address)` is untouched.)

## Ingestion & enrichment writes
- **`ingest-pools`** (both upsert paths): write `NULLIF(raw.feeTier, 0)` so the
  sentinel is never stored. On the address-bearing path, **preserve an
  already-known fee** rather than clobbering it with a source NULL:
  `fee_tier = COALESCE(EXCLUDED.fee_tier, pools.fee_tier)` — avoids a transient
  NULL window between the ingest and enrich steps and keeps a verified fee if a
  later ingest omits it (a fixed pool's fee doesn't change).
- **`enrich-pools-subgraph` / `enrich-pools-solana`**: write the verified fee into
  `fee_tier` instead of `fee_tier_verified`, only when we actually got one:
  `SET fee_tier = COALESCE($verifiedFee, fee_tier)`. Solana's CLMM `pool_version`
  handling is unchanged.

## Readers (drop the COALESCE)
- `apps/pair-engine/src/db.ts`: `SUM(volume * COALESCE(fee_tier_verified, fee_tier))`
  → `SUM(volume * fee_tier)` (NULL fees drop out of the sum; the outer
  `COALESCE(SUM(...),0)` already returns 0 when all NULL).
- `apps/api/src/services/poolService.ts` + `apps/api/src/routes/pools.ts`:
  `COALESCE(fee_tier_verified, fee_tier) AS fee_tier` → `fee_tier`.
- `apps/api/src/routes/backtest.ts`: the pool-selection `ORDER BY
  (COALESCE(fee_tier_verified, fee_tier) = $2) DESC` → `(fee_tier = $2) DESC`; the
  fee passed to `runBacktest` reads `fee_tier` directly.

## Semantics after retirement
- `fee_opportunity` / backtest fees use the real fee where known; unknown-fee
  pools contribute **nothing** (NULL) instead of a misleading 0 — same numeric
  result, honest meaning.
- **Provenance note (decision):** collapsing loses the explicit "on-chain
  verified vs source-reported" flag. Nothing currently consumes that distinction,
  and 96% of source fees are the sentinel anyway, so this spec **drops it**. If
  provenance is later wanted, add a small `fee_tier_source` enum — cheaper than
  keeping a whole shadow fee column. (Open question for review.)

## Changes (summary)
- `packages/db/migrations/015_retire_fee_tier_sentinel.sql` (new).
- `apps/ingestion/src/ingest-pools.ts`: `NULLIF` on write + COALESCE-preserve on
  the address path.
- `apps/ingestion/src/enrich-pools-subgraph.ts` + `enrich-pools-solana.ts`: write
  `fee_tier` (COALESCE-guarded) instead of `fee_tier_verified`.
- `apps/pair-engine/src/db.ts`, `apps/api/src/services/poolService.ts`,
  `apps/api/src/routes/pools.ts`, `apps/api/src/routes/backtest.ts`: drop COALESCE.
- Tests updated (the ingestion enrich tests reference `fee_tier_verified`); no
  new type/web surface.

## Acceptance criteria
- [ ] Migration applies on prod-shaped data: `fee_tier` nullable, backfilled to
      the real fee / NULL, `fee_tier_verified` gone, addrless index recreated
      `NULLS NOT DISTINCT`.
- [ ] No `fee_tier = 0` rows remain post-migration (0 → NULL or a real fee);
      no address-less duplicate rows appear on the next ingest.
- [ ] Enriched pools carry their real `fee_tier`; the 14-day per-chain fee read
      matches the pre-retirement numbers (values unchanged, just single-column).
- [ ] `COALESCE(fee_tier_verified, …)` no longer appears in the codebase; API
      still serves `feeTier` unchanged (no web/types diff).
- [ ] typecheck / lint / build / full suite pass; scratch-Postgres e2e green.

## Verification
Scratch-Postgres e2e (as spec 018): apply through 015; assert column dropped, no
`fee_tier=0` rows, addrless dedupe holds with NULL fees (insert two address-less
same-key NULL-fee pools → one row), address-bearing COALESCE-preserve keeps a fee
when a later ingest omits it. Unit tests for the ingest write helper. Live: a
`workflow_dispatch` run, then confirm no `fee_tier=0` rows and the per-chain fee
read is unchanged from spec 018's numbers.

## Out of scope
- A `fee_tier_source` provenance enum (only if a consumer needs it later).
- Backfilling real fees for pools no enrichment covers (Avalanche, Meteora,
  address-less) — they stay NULL until a source provides the fee.
