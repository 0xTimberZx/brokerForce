-- 015: retire the fee_tier = 0 sentinel (spec 019).
--
-- Spec 013 added fee_tier_verified as a shadow column ONLY because fee_tier was
-- part of the pool identity key and couldn't be mutated in place. Spec 018 made
-- identity address-based ((chain, pool_address)), so fee_tier is free to hold the
-- real fee. Collapse the two columns into a single authoritative, NULLABLE
-- fee_tier where NULL = genuinely unknown -- retiring the ambiguous "0 = UNKNOWN"
-- sentinel (896/931 rows sat at 0) and the COALESCE(fee_tier_verified, fee_tier)
-- read pattern.

-- 1. fee_tier must be able to say "unknown" as NULL rather than 0.
ALTER TABLE pools ALTER COLUMN fee_tier DROP NOT NULL;

-- 2. Fold the verified fee in: verified where we have it, else the source fee if
--    it was a real non-zero value, else NULL (unknown -- no more 0 sentinel).
UPDATE pools SET fee_tier = COALESCE(fee_tier_verified, NULLIF(fee_tier, 0));

-- 3. Drop the now-redundant shadow column. (The API never exposed it -- routes
--    already served COALESCE(...) AS fee_tier -- so no type/web surface changes.)
ALTER TABLE pools DROP COLUMN fee_tier_verified;

-- 4. The address-less identity index (spec 018) keys on fee_tier. Postgres treats
--    NULLs as DISTINCT in a unique index by default, so NULLable fee_tier would
--    let two address-less pools with the same (pair,dex,chain) and NULL fee both
--    insert. PG 17 (prod is 17.6) supports NULLS NOT DISTINCT -- recreate the
--    index with it so NULL fees dedupe. (The address-bearing index
--    (chain, pool_address) is unaffected and left untouched.)
DROP INDEX IF EXISTS pools_pair_dex_chain_fee_addrless_uniq;
CREATE UNIQUE INDEX pools_pair_dex_chain_fee_addrless_uniq
  ON pools (pair_id, dex, chain, fee_tier) NULLS NOT DISTINCT
  WHERE pool_address IS NULL;
