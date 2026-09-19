-- 014: address-based pool identity (spec 018).
--
-- The pool identity key from migration 002, pools_pair_dex_chain_fee_unique
-- (pair_id, dex, chain, fee_tier), collapses DISTINCT on-chain pools onto one
-- row whenever fee_tier is the "0 = UNKNOWN" sentinel (every Solana pool, many
-- EVM pools). ingest-pools then upserts several physical pools (different
-- addresses, different real fees) onto that single row and writes all their
-- snapshots under one pool_id -- the root cause of the AVAX/USDC 4%-on-$2.6M
-- artifact, the ETH/LINK fee "flapping", and per-cycle pool_history mixing.
--
-- Migration 002 itself flagged the fix: "Pool contract address would be the
-- truer identity key ... add one if/when two same-fee pools for one pair on one
-- DEX/chain actually appear." Spec 009 added pool_address; spec 011 validated it.
-- This migration makes it the identity: (chain, pool_address) for address-bearing
-- pools, keeping the old key only for the address-less rows.

-- 1. Canonicalise EVM addresses (EIP-55 checksum casing is display-only, so a
--    stable key needs lower-case). Solana / base58 addresses are case-SIGNIFICANT
--    and must NOT be touched -- they never start with '0x', so this is safe.
UPDATE pools
   SET pool_address = lower(pool_address)
 WHERE pool_address LIKE '0x%'
   AND pool_address <> lower(pool_address);

-- 2. Guard: the new (chain, pool_address) unique index cannot be created if any
--    address-bearing duplicates exist. Fail loudly (rather than silently losing
--    the index) so a data regression is caught at migration time.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT chain, pool_address
      FROM pools
     WHERE pool_address IS NOT NULL
     GROUP BY chain, pool_address
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'migration 014: % (chain, pool_address) duplicate group(s) exist -- resolve before switching identity to address', dup_count;
  END IF;
END $$;

-- 3. Drop the old all-rows identity constraint.
ALTER TABLE pools DROP CONSTRAINT IF EXISTS pools_pair_dex_chain_fee_unique;

-- 4a. True identity for address-bearing pools: one row per on-chain pool. fee_tier
--     is no longer an identity component for these, so distinct-fee pools at
--     distinct addresses stop colliding.
CREATE UNIQUE INDEX IF NOT EXISTS pools_chain_address_uniq
  ON pools (chain, pool_address)
  WHERE pool_address IS NOT NULL;

-- 4b. Preserve migration-002 behaviour for address-less rows (no source address
--     yet): they still de-duplicate on (pair_id, dex, chain, fee_tier).
CREATE UNIQUE INDEX IF NOT EXISTS pools_pair_dex_chain_fee_addrless_uniq
  ON pools (pair_id, dex, chain, fee_tier)
  WHERE pool_address IS NULL;
