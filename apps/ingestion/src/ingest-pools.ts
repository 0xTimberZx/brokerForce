// Pool-level ingestion + the real active-tier promotion path -- the job
// that poolService.ts's "a pool-ingestion job that doesn't exist yet"
// comment was waiting for, and the honest replacement for
// apps/ort-engine/src/mark-pair-active-for-testing.ts's manual bypass.
//
// Per Database.md §3's tier-gated intensity model:
//
//   - ACTIVE pairs: every pool the source returns is upserted into `pools`
//     and a snapshot appended to `pool_history` -- this run IS the
//     "continuous polling" leg (cadence comes from however this script is
//     scheduled: cron, GitHub Action, etc.).
//   - LIMITED pairs: not continuously stored as a rule -- but the gate
//     (Architecture.md §5) needs a 7-day observed volume average before it
//     can ever promote anyone, and that evidence has to live somewhere. So
//     for limited pairs, ONLY pools already at/above the $50k TVL bar get a
//     stored row + snapshot ("gate candidates"). Long-tail pools nobody
//     would promote stay unstored, keeping §3's cost model intact.
//   - EXCLUDED-STABLE pairs: never polled here, never promoted --
//     structural exclusion regardless of activity, per Architecture.md §5.
//
// Promotion: a limited pair flips to 'active' when at least one of its
// stored pools clears the full gate in tier-gate.ts (TVL >= $50k AND
// >= 7 distinct observed days AND 7-day avg volume >= $10k).
// Demotion: never automatic -- active pairs that have slipped below the
// bar are logged as candidates only (see tier-gate.ts's header for why).
//
// Run with: npm run ingest-pools --workspace=apps/ingestion
// Requires DATABASE_URL (see .env.example) and migrations applied.

import "dotenv/config";
import { query, closePool } from "@brokerforce/db";
import {
  GeckoTerminalPoolSource,
  PoolSourceUnavailableError,
  type PoolSource,
  type RawPoolData,
} from "@brokerforce/pool-sources";
import {
  pairQualifiesForActive,
  poolClearsGate,
  ACTIVE_TVL_THRESHOLD_USD,
  type PoolGateEvidence,
} from "./tier-gate.js";

// GeckoTerminal's public tier allows ~30 calls/min; one search call per pair
// at this spacing stays safely under it even with retries mixed in.
const PER_PAIR_DELAY_MS = 2_500;

// Gate evidence window: slightly wider than 7 calendar days so daily runs
// (which drift by minutes) still accumulate 7 countable distinct days.
const GATE_WINDOW_DAYS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PairRow {
  id: string;
  asset_a: string;
  asset_b: string;
  tier: "active" | "limited";
}

async function upsertPoolWithSnapshot(pairId: string, raw: RawPoolData): Promise<void> {
  const rows = await query<{ id: string }>(
    `INSERT INTO pools (pair_id, dex, chain, fee_tier, tvl, volume, active_liquidity, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (pair_id, dex, chain, fee_tier) DO UPDATE SET
       tvl = EXCLUDED.tvl,
       volume = EXCLUDED.volume,
       active_liquidity = EXCLUDED.active_liquidity,
       updated_at = now()
     RETURNING id`,
    [pairId, raw.dex, raw.chain, raw.feeTier, raw.tvl, raw.volume, raw.activeLiquidity]
  );
  const pool = rows[0];
  if (!pool) {
    throw new Error(`pools upsert for pair ${pairId} (${raw.dex}/${raw.chain}) returned no row`);
  }
  await query(`INSERT INTO pool_history (pool_id, "timestamp", tvl, volume) VALUES ($1, now(), $2, $3)`, [
    pool.id,
    raw.tvl,
    raw.volume,
  ]);
}

/** Gate evidence per stored pool of a pair: current TVL plus the observed
 * daily-volume record accumulated in pool_history. */
async function fetchGateEvidence(pairId: string): Promise<PoolGateEvidence[]> {
  const rows = await query<{ tvl: string | null; distinct_days: string; avg_daily_volume: string | null }>(
    `SELECT
       p.tvl,
       COALESCE(d.distinct_days, 0) AS distinct_days,
       d.avg_daily_volume
     FROM pools p
     LEFT JOIN (
       SELECT pool_id,
              COUNT(*) AS distinct_days,
              AVG(day_volume) AS avg_daily_volume
       FROM (
         SELECT pool_id, date_trunc('day', "timestamp") AS day, AVG(volume) AS day_volume
         FROM pool_history
         WHERE "timestamp" >= now() - ($2 || ' days')::interval AND volume IS NOT NULL
         GROUP BY pool_id, date_trunc('day', "timestamp")
       ) daily
       GROUP BY pool_id
     ) d ON d.pool_id = p.id
     WHERE p.pair_id = $1`,
    [pairId, String(GATE_WINDOW_DAYS)]
  );
  return rows.map((r) => ({
    currentTvl: r.tvl === null ? null : Number(r.tvl),
    distinctDays: Number(r.distinct_days),
    avgDailyVolume: r.avg_daily_volume === null ? null : Number(r.avg_daily_volume),
  }));
}

async function main() {
  const source: PoolSource = new GeckoTerminalPoolSource();

  // excluded-stable is filtered at the query -- never polled, never promoted.
  const pairs = await query<PairRow>(
    `SELECT id, asset_a, asset_b, tier FROM pairs WHERE tier IN ('active', 'limited') ORDER BY tier, asset_a, asset_b`
  );
  console.log(`Polling pools for ${pairs.length} pair(s) (active + limited; excluded-stable skipped).`);

  let stored = 0;
  let promoted = 0;
  let sourceFailures = 0;

  for (const pair of pairs) {
    let raw: RawPoolData[];
    try {
      raw = await source.fetchPoolsForPair({ pairAssetA: pair.asset_a, pairAssetB: pair.asset_b });
    } catch (err) {
      // One pair's source failure shouldn't kill the whole run -- log it,
      // count it, and keep polling the rest. Anything other than the
      // source's own "unavailable" signal is a real bug and should throw.
      if (err instanceof PoolSourceUnavailableError) {
        sourceFailures++;
        console.warn(`  ${pair.asset_a}/${pair.asset_b}: source unavailable (${err.message}) -- skipping this run.`);
        await sleep(PER_PAIR_DELAY_MS);
        continue;
      }
      throw err;
    }

    // Tier-gated storage: everything for active pairs, gate candidates only
    // (TVL already at/above the bar) for limited pairs -- see header.
    const toStore =
      pair.tier === "active"
        ? raw
        : raw.filter((p) => p.tvl !== null && p.tvl >= ACTIVE_TVL_THRESHOLD_USD);

    for (const rawPool of toStore) {
      await upsertPoolWithSnapshot(pair.id, rawPool);
      stored++;
    }

    const evidence = await fetchGateEvidence(pair.id);
    if (pair.tier === "limited" && pairQualifiesForActive(evidence)) {
      await query(`UPDATE pairs SET tier = 'active' WHERE id = $1`, [pair.id]);
      promoted++;
      console.log(
        `  PROMOTED ${pair.asset_a}/${pair.asset_b} to active tier -- a pool cleared ` +
          `$${ACTIVE_TVL_THRESHOLD_USD.toLocaleString()} TVL with a 7-day observed volume average over the bar.`
      );
    } else if (pair.tier === "active" && evidence.length > 0 && !evidence.some(poolClearsGate)) {
      // Demotion candidate: surfaced, never acted on -- tier-gate.ts header.
      console.warn(
        `  DEMOTION CANDIDATE: ${pair.asset_a}/${pair.asset_b} is active but no pool currently clears the gate.`
      );
    }

    await sleep(PER_PAIR_DELAY_MS);
  }

  console.log(
    `Done. Stored ${stored} pool snapshot(s), promoted ${promoted} pair(s), ` +
      `${sourceFailures} source failure(s) skipped.`
  );
}

main()
  .catch((err) => {
    console.error("Pool ingestion failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
