// Uniswap-v3 subgraph enrichment step (spec 012). Runs AFTER ingest-pools in
// the daily pipeline, once pool rows + their validated on-chain addresses
// exist. For every identified v3 pool it fills the columns the primary sources
// (DexScreener / GeckoTerminal) can't:
//   - active_liquidity_distribution  (pool.ticks -> [{priceTick, liquidity}])
//   - swap_count_7d                  (Σ of 7 per-day poolDayDatas.txCount)
// unique_lp_count is deliberately left NULL: the subgraph's
// liquidityProviderCount is unimplemented (probe-confirmed 0 everywhere).
//
// DEGRADE-SAFE BY DESIGN -- this step must never break the pipeline:
//   - No GRAPH_API_KEY            -> log + exit 0, columns stay NULL.
//   - Chain with no known         -> skip that chain (logged).
//     v3 deployment (optimism)
//   - A pool the subgraph doesn't -> leave its columns NULL, never fabricate.
//     know / a query error
// It only ever UPDATEs existing rows -- it never creates pools and never
// touches the pool identity key, tier gate, or any figure ingest-pools owns.
//
// Run with: npm run enrich-pools-subgraph --workspace=apps/ingestion
// Requires DATABASE_URL and GRAPH_API_KEY (a The Graph gateway API key).

import "dotenv/config";
import { query, closePool } from "@brokerforce/db";
import { UniswapV3Subgraph } from "./sources/uniswapV3Subgraph.js";

// Gentle spacing between subgraph requests -- we query one pool at a time and
// the v3 cohort is modest, so there's no need to hammer the gateway.
const PER_POOL_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface V3PoolRow {
  id: string;
  chain: string;
  dex: string;
  pool_address: string;
  pool_version: string | null;
}

async function main() {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    // Not an error: the pipeline runs fine without enrichment, the columns
    // just stay NULL and the UI shows its existing "pending" states.
    console.log("enrich-pools-subgraph: GRAPH_API_KEY not set -- skipping subgraph enrichment (columns stay NULL).");
    return;
  }
  const gatewayBase = process.env.GRAPH_API_URL; // optional override; undefined -> client default

  // spec 016: select by (chain, dex) rather than pool_version alone. Include
  // pool_version-NULL pools on mapped DEXs -- BSC's uniswap pools arrive untagged
  // and the subgraph is authoritative on whether they're really v3 (a pool it
  // returns gets pool_version set to 'v3' below; one it doesn't know stays NULL).
  // Explicitly-non-v3 rows (v2, etc.) are excluded to avoid guaranteed-miss queries.
  const pools = await query<V3PoolRow>(
    `SELECT id, chain, dex, pool_address, pool_version
       FROM pools
      WHERE pool_address IS NOT NULL
        AND (pool_version = 'v3' OR pool_version IS NULL)
      ORDER BY chain, dex`
  );
  console.log(`enrich-pools-subgraph: ${pools.length} candidate pool(s) (v3 or untagged) with an on-chain address.`);
  if (pools.length === 0) return;

  // One client per (chain, dex); a pair with no known-healthy v3 deployment
  // (e.g. optimism:uniswap, or any non-tick DEX) yields null and its pools are
  // skipped.
  const clients = new Map<string, UniswapV3Subgraph | null>();
  const clientFor = (chain: string, dex: string): UniswapV3Subgraph | null => {
    const key = `${chain}:${dex}`;
    if (!clients.has(key)) clients.set(key, UniswapV3Subgraph.forChainDex(chain, dex, apiKey, gatewayBase));
    return clients.get(key) ?? null;
  };

  let enriched = 0; // rows we wrote at least one real value to
  let unknownPool = 0; // subgraph returned null for the pool
  let skippedChain = 0; // chain has no mapped deployment
  let failed = 0; // query/transport error for that pool
  let queries = 0; // subgraph requests actually issued (budget watch)
  const skippedPairs = new Set<string>(); // "chain:dex" with no mapped deployment

  for (const pool of pools) {
    const client = clientFor(pool.chain, pool.dex);
    if (!client) {
      skippedChain++;
      skippedPairs.add(`${pool.chain}:${pool.dex}`);
      continue;
    }
    try {
      queries++;
      const result = await client.enrichPool(pool.pool_address);
      if (!result) {
        unknownPool++;
      } else {
        // Store [] distribution as NULL (nothing to show) rather than an empty
        // array, so the read path's "no data" check stays a simple NULL test.
        const dist = result.activeLiquidityDistribution.length > 0 ? JSON.stringify(result.activeLiquidityDistribution) : null;
        // fee_tier_verified (spec 013): the real fee tier from pool.feeTier,
        // fractional. NULL when the subgraph didn't report it -> consumers fall
        // back to the fee_tier sentinel. Additive: pools.fee_tier (the identity
        // key) is never touched here.
        //
        // pool_version = 'v3' (spec 016): a pool the v3 subgraph *returned* is
        // authoritatively a v3(-schema) pool, so confirm the version here. This
        // progressively fixes the identification gap for untagged (NULL-version)
        // pools without touching ingest or the identity key (pool_version isn't
        // part of it). Only set on a real hit -- the no-result branch leaves
        // everything NULL.
        await query(
          `UPDATE pools
              SET swap_count_7d = $1,
                  active_liquidity_distribution = $2::jsonb,
                  fee_tier_verified = $3,
                  pool_version = 'v3',
                  updated_at = now()
            WHERE id = $4`,
          [result.swapCount7d, dist, result.feeTierFractional, pool.id]
        );
        if (result.swapCount7d !== null || dist !== null || result.feeTierFractional !== null) enriched++;
        else unknownPool++;
      }
    } catch (err) {
      // Availability/transport errors are expected operational noise (the
      // gateway rotates indexers); count + skip, never fail the pipeline.
      failed++;
      console.warn(`  ${pool.chain} pool ${pool.pool_address}: subgraph enrichment failed -- ${(err as Error).message}`);
    }
    await sleep(PER_POOL_DELAY_MS);
  }

  if (skippedPairs.size > 0) {
    console.log(`  Skipped ${skippedChain} pool(s) on (chain:dex) with no mapped v3 subgraph: ${[...skippedPairs].join(", ")}.`);
  }
  console.log(
    `enrich-pools-subgraph: enriched ${enriched}, ${unknownPool} not in subgraph, ${failed} failed, ` +
      `${queries} subgraph queries issued.`
  );
}

main()
  .catch((err) => {
    // A top-level failure (e.g. DB down) is a real error and should surface,
    // but per-pool subgraph failures above are already swallowed so a flaky
    // gateway never lands here.
    console.error("enrich-pools-subgraph failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
