// Solana CLMM enrichment step (spec 017, Phase 1). Runs AFTER ingest-pools in the
// daily pipeline, sibling to enrich-pools-subgraph (which is EVM/subgraph-only and
// never touched here). For Solana Orca + Raydium pools it fills the one column the
// primary sources (DexScreener / GeckoTerminal) leave at the sentinel:
//   - fee_tier_verified   (Orca feeRate / Raydium tradeFeeRate -> fractional)
// and, for genuinely concentrated pools, marks:
//   - pool_version = 'clmm'   (Orca Whirlpools; Raydium "Concentrated" pools)
// Raydium "Standard" (AMM-v4 / CPMM) pools get the fee tier but NOT pool_version
// -- they're constant-product, not concentrated. The per-tick
// active_liquidity_distribution is on-chain (TickArray accounts) and is Phase 2.
//
// DEGRADE-SAFE BY DESIGN (mirrors enrich-pools-subgraph):
//   - A dex with no client            -> skip (logged).
//   - A pool the API doesn't know     -> leave columns NULL, never fabricate.
//   - An API / transport error        -> count + skip, never fail the pipeline.
// It only ever UPDATEs existing rows -- never creates pools, never touches the
// pool identity key (pair_id, dex, chain, fee_tier) or ingest.
//
// Run with: npm run enrich-pools-solana --workspace=apps/ingestion
// Requires DATABASE_URL. Orca/Raydium public REST need no API key.

import "dotenv/config";
import { query, closePool } from "@brokerforce/db";
import { OrcaWhirlpools } from "./sources/orcaWhirlpools.js";
import { RaydiumClmm } from "./sources/raydiumClmm.js";

// Gentle spacing between REST calls -- one pool at a time, modest cohort.
const PER_POOL_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SolanaPoolRow {
  id: string;
  dex: string;
  pool_address: string;
}

async function main() {
  const orca = new OrcaWhirlpools();
  const raydium = new RaydiumClmm();

  const pools = await query<SolanaPoolRow>(
    `SELECT id, dex, pool_address
       FROM pools
      WHERE chain = 'solana' AND dex IN ('orca','raydium') AND pool_address IS NOT NULL
      ORDER BY dex`
  );
  console.log(`enrich-pools-solana: ${pools.length} Solana Orca/Raydium pool(s) with an on-chain address.`);
  if (pools.length === 0) return;

  let enriched = 0; // rows we wrote a fee tier to
  let clmmMarked = 0; // rows also marked pool_version='clmm'
  let unknownPool = 0; // API returned nothing usable for the pool
  let failed = 0; // API/transport error for that pool
  let queries = 0; // requests actually issued (budget watch)

  for (const pool of pools) {
    try {
      queries++;
      // Resolve the fee tier and whether the pool is concentrated (-> 'clmm').
      let feeTierFractional: number | null = null;
      let isConcentrated = false;
      if (pool.dex === "orca") {
        const r = await orca.fetchPool(pool.pool_address);
        feeTierFractional = r?.feeTierFractional ?? null;
        isConcentrated = r !== null; // every Whirlpool is CLMM
      } else if (pool.dex === "raydium") {
        const r = await raydium.fetchPool(pool.pool_address);
        feeTierFractional = r?.feeTierFractional ?? null;
        isConcentrated = r?.poolKind === "clmm";
      }

      if (feeTierFractional === null) {
        unknownPool++;
      } else {
        // pool_version -> 'clmm' only for concentrated pools; NULL stays NULL for
        // Raydium Standard (constant-product) pools so we never imply ticks they
        // don't have. Additive: pools.fee_tier (identity key) is never touched.
        const poolVersion = isConcentrated ? "clmm" : null;
        await query(
          `UPDATE pools
              SET fee_tier_verified = $1,
                  pool_version = COALESCE($2, pool_version),
                  updated_at = now()
            WHERE id = $3`,
          [feeTierFractional, poolVersion, pool.id]
        );
        enriched++;
        if (poolVersion) clmmMarked++;
      }
    } catch (err) {
      failed++;
      console.warn(`  ${pool.dex} pool ${pool.pool_address}: solana enrichment failed -- ${(err as Error).message}`);
    }
    await sleep(PER_POOL_DELAY_MS);
  }

  console.log(
    `enrich-pools-solana: enriched ${enriched} (${clmmMarked} marked clmm), ` +
      `${unknownPool} not resolved, ${failed} failed, ${queries} requests issued.`
  );
}

main()
  .catch((err) => {
    // A top-level failure (e.g. DB down) is a real error and should surface, but
    // per-pool API failures above are swallowed so a flaky endpoint never lands here.
    console.error("enrich-pools-solana failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
