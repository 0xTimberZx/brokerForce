# 018 — Pool Identity Convergence Fix (address-based identity)

> **Status: Drafted 2026-09-19.** Fixes the data-integrity bug where multiple
> distinct on-chain pools collapse onto a single `pools` row — the root cause
> behind the AVAX/USDC "4% tier on $2.6M volume" artifact (spec 017 sanity-check),
> the ETH/LINK fee-tier "flapping" (spec 016 era), and the per-cycle
> multiple-`pool_history`-rows-per-`pool_id` mixing. One fix, three symptoms.

## The bug (mechanism)
`ingest-pools.ts::upsertPoolWithSnapshot` upserts on
`ON CONFLICT (pair_id, dex, chain, fee_tier)` (migration 002's
`pools_pair_dex_chain_fee_unique`). When a source reports **no** fee tier —
every Solana pool, and many EVM pools — `fee_tier` is the **`0` sentinel**. So
when `fetchPoolsForPair` returns *several distinct physical pools* for one pair
on one DEX/chain (different addresses, different real fee tiers, all
`fee_tier=0`), the per-pool loop:

```
for (const rawPool of toStore) await upsertPoolWithSnapshot(pair.id, rawPool);
```

- Pool A (address X, $66.7M TVL) → INSERT → `pool_history` row under `pool_id P`.
- Pool B (address Y, $10k TVL, real 4% fee) → **ON CONFLICT on the same key** →
  **UPDATE the same row P** to B's values → another `pool_history` row under `P`.

Net: one `pools` row (last-write-wins on address/fee), but `pool_history`
accumulates **both pools' snapshots under one `pool_id`**.

### The AVAX/USDC evidence (from the spec-017 sanity-check)
`pool_id 15b39a51` (AVAX/USDC, raydium, solana, `fee_tier=0`):
- Current `pools` row: address `3XKSnFq…`, **TVL $10,009**, `fee_tier_verified=0.04`.
- `pool_history` under the same id: **TVL ~$66.7M every day**, ~$200k/day volume.

The 14-day fee read then multiplied **the $66.7M pool's $2.6M volume** by **the
$10k pool's 4% fee** → a bogus $105k. The 4% tier was mapped *correctly* from the
API; the number is wrong because two pools share one identity.

## Root cause (one cause, three symptoms)
`fee_tier=0` is not a real discriminator, so the identity key
`(pair_id, dex, chain, fee_tier)` cannot separate co-located pools. Migration 002
foresaw exactly this: *"Pool contract address would be the truer identity key,
but no source column for it exists yet; add one if/when two same-fee pools for one
pair on one DEX/chain actually appear."* Spec 009 added `pool_address`; spec 011
validated it. It's time to make it the identity.

Symptoms this fixes:
1. **AVAX/USDC** mismatched volume×fee (above).
2. **ETH/LINK fee flapping** — the 0.05% and 0.3% Uniswap-v3 pools both carry
   `fee_tier=0`, so they collide on one row and `fee_tier_verified` flips run to
   run depending on which won the upsert.
3. **Per-cycle history mixing** — the DISTINCT-ON-date/max-tvl dedup used in the
   14-day reads is a *workaround* for this; address identity removes the need.

## Data shape the migration must survive (2026-09-19)
- 727 pools: **177 (24%) `pool_address IS NULL`**, 550 with an address.
- **420 EVM addresses are mixed-case** (EIP-55 checksummed) → identity must be
  **case-canonical**, or `0xAbC` and `0xabc` count as two pools and ON CONFLICT
  misses. **But** Solana addresses are base58 and **case-sensitive** — blanket
  `lower()` would wrongly merge distinct Solana pools. Canonicalisation must be
  **chain-aware**.
- **0** `(chain, lower-address)` collisions today → the unique index can be added
  with no dedup pre-step (after EVM lowercasing).

## Design

### Address canonicalisation (pure, chain-aware)
New `canonicalPoolAddress(chain, address)` in `packages/pool-sources/normalize.ts`:
- `0x`-prefixed (all our EVM chains) → **lower-case** (checksum is display-only).
- Everything else (Solana base58, …) → **unchanged** (case is significant).
- `null`/empty → `null`.
Used by `ingest-pools` on write, and reused by `enrich-pools-subgraph` /
`enrich-pools-solana` (which currently lower-case ad hoc) so all three agree.

### New identity — address when present, old key only for address-less
Two **partial** unique indexes replace the single all-rows constraint:
- `pools_chain_address_uniq  UNIQUE (chain, pool_address) WHERE pool_address IS NOT NULL`
  — the true identity for the 550 (and growing) address-bearing pools. `fee_tier`
  is no longer an identity component for them, so distinct-fee pools at distinct
  addresses stop colliding.
- `pools_pair_dex_chain_fee_addrless_uniq  UNIQUE (pair_id, dex, chain, fee_tier) WHERE pool_address IS NULL`
  — preserves migration-002 behaviour for the 177 address-less rows (no
  regression, no duplicate inserts for them).

### Migration `014_pool_address_identity.sql`
1. **Canonicalise EVM addresses:** `UPDATE pools SET pool_address = lower(pool_address)
   WHERE pool_address LIKE '0x%' AND pool_address <> lower(pool_address);`
   (Solana rows untouched.)
2. **Guard:** assert no `(chain, pool_address)` duplicates remain (0 today; the
   migration fails loudly rather than silently dropping the index if that changes).
3. `ALTER TABLE pools DROP CONSTRAINT pools_pair_dex_chain_fee_unique;`
4. Create the two partial unique indexes above.
No column adds; `pool_history.pool_id` FK unchanged.

### Two-path upsert (`upsertPoolWithSnapshot`)
Canonicalise `raw.address` first, then branch on presence:
- **address present:** `INSERT … ON CONFLICT (chain, pool_address)
  WHERE pool_address IS NOT NULL DO UPDATE SET tvl, volume, active_liquidity,
  pool_version, fee_tier = EXCLUDED.fee_tier, updated_at = now()` (pair_id/dex/chain
  are fixed for an address, so not updated). Then the `pool_history` insert as today.
- **address absent:** `INSERT … ON CONFLICT (pair_id, dex, chain, fee_tier)
  WHERE pool_address IS NULL DO UPDATE …` — unchanged semantics.
Postgres matches a partial index by restating its predicate in `ON CONFLICT`.

## Transitional behaviour (honest)
- **Self-heals forward:** the first post-migration ingest cycle inserts the
  previously-shadowed pools as their own rows (they no longer conflict). Within one
  cycle, a collapsed `(pair,dex,chain,fee_tier)` slot fans back out to one row per
  address.
- **Historical `pool_history` stays mixed** under the old `pool_id` for snapshots
  written *before* the migration; new snapshots attach to the correct per-address
  row. The 14-day reads clean up as the pre-migration rows age out (~14 days); the
  90-day windows take longer. We do **not** delete historical rows — that would
  erase tier-gate evidence (7-day promotion record). Documented, not scrubbed.
- **Stale address-less rows:** a pool first seen without an address (address-less
  row) that later gains an address will get a *new* address-keyed row, orphaning
  the old one. Low volume (most pools have addresses); a stale-row sweep is a
  separate follow-on, not this spec.

## Downstream impact
- Consumers already aggregate per **pair** (ORT `MAX(tvl)` subquery, fee reads,
  backtest pool-selection `ORDER BY fee-match, tvl DESC`), so more (correct) pool
  rows per pair is strictly better — the deepest/right pool is now distinct, not an
  overwrite. No read-path code must change.
- `pools` row count rises (previously-shadowed pools become real) → slightly more
  enrichment queries (each address enriched once); within the free-tier budget the
  enrich steps already log.
- Tier-gate: a newly-split pool starts its 7-day evidence fresh; pair tier is
  unaffected (demotion is manual). Documented.
- The `fee_tier=0` sentinel can now be *retired* (write the real fee tier into
  `fee_tier` itself, since it's no longer an identity component) — **out of scope
  here**, a clean follow-on now that identity no longer depends on it.

## Changes (summary)
- `packages/db/migrations/014_pool_address_identity.sql` (new).
- `packages/pool-sources/src/normalize.ts`: `canonicalPoolAddress(chain, address)`
  (pure, unit-tested); adopt in the two enrich steps.
- `apps/ingestion/src/ingest-pools.ts`: canonicalise on write; two-path upsert.
- Tests: `canonicalPoolAddress` (EVM lower, Solana preserved, null); an upsert
  identity test — two same-fee pools with different addresses → **two** rows (not
  one), same address twice → update-in-place, address-less → old-key path.

## Acceptance criteria
- [ ] Migration applies cleanly on prod-shaped data (EVM lowercased, Solana
      untouched, old constraint dropped, both partial indexes present); the
      duplicate guard passes.
- [ ] After a post-migration ingest cycle, a pair that had colliding pools (e.g.
      AVAX/USDC raydium, ETH/LINK uniswap) shows **one `pools` row per distinct
      address**, each with its own `fee_tier_verified`.
- [ ] New `pool_history` rows attach one-per-cycle to the correct per-address
      `pool_id` (no more multiple physical pools under one id).
- [ ] The 14-day fee read no longer glues one pool's volume to another's fee (the
      AVAX/USDC $105k artifact disappears once history rolls forward).
- [ ] Address-less pools keep updating in place (no duplicate rows).
- [ ] Pure helper unit-tested; typecheck / lint / build / full suite pass; no
      read-path/ORT regression.

## Verification
Unit tests for `canonicalPoolAddress` + the two-path upsert. Scratch-Postgres e2e:
seed one pair, feed two `RawPoolData` with the same `(dex,chain,fee_tier=0)` but
different addresses → assert **two** rows + two independent `pool_history` streams;
re-feed the same two → assert update-in-place (still two rows, no dupes); feed an
address-less pool → old-key path. Apply migration 014 against a prod snapshot copy;
assert index set + zero duplicate collisions. Live confirmation via a
`workflow_dispatch` pipeline run, then re-query the AVAX/USDC + ETH/LINK pairs for
one-row-per-address and a sane per-chain fee read.

## Out of scope
- Retiring the `fee_tier=0` sentinel (writing the real fee into `fee_tier`) — a
  follow-on unblocked by this spec.
- One-time historical `pool_history` cleanup / re-attribution (we let it age out to
  preserve gate evidence).
- A general stale-row sweep for orphaned address-less rows.
