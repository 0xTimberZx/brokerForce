// Entry point for asset-level ingestion -- the first piece of the build
// sequence in docs/Roadmap.md §4 ("ingestion -> Asset model -> Pair Engine
// -> 003 -> 004 -> ..."). This script only handles the Asset model layer:
// per-asset price/volume/market-cap data. Pool-level ingestion (tier-gated,
// per docs/Database.md §3) and the Pair Engine itself are separate, later
// pieces of work, not handled here.
//
// Run with: npm run ingest --workspace=apps/ingestion
// Requires DATABASE_URL set (see .env.example) and a Postgres instance with
// the TimescaleDB extension + packages/db/migrations/001_init.sql already applied.

import "dotenv/config";
import { closePool } from "@brokerforce/db";
import type { AssetVerificationStatus } from "@brokerforce/types";
import { TRACKED_ASSETS, getAssetsNeedingVerification, type TrackedAsset } from "./config/assets.js";
import {
  fetchCurrentSnapshots,
  fetchSingleSnapshot,
  fetchDailyCandles,
  type AssetSnapshot,
} from "./sources/coingecko.js";
import { upsertAsset, upsertDailyCandles } from "./db/upsert.js";

const PER_ASSET_DELAY_MS = 2000; // space out per-asset OHLC/chart calls; tune to your CoinGecko plan

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function symbolMatches(asset: TrackedAsset, snapshot: AssetSnapshot | undefined): boolean {
  return !!snapshot && snapshot.symbol.toLowerCase() === asset.symbol.toLowerCase();
}

/**
 * Identity verification + scrap-and-replace policy (see config/assets.ts for
 * the full reasoning). Returns the snapshot to actually use (or undefined if
 * scrapped) plus the resulting verification status to record.
 *
 * What this CAN catch: a broken/wrong id -- the response doesn't match the
 * expected ticker at all. What this CANNOT fully resolve: a genuine ticker
 * collision, where two real, unrelated projects share a ticker and BOTH
 * could pass this check. A passing fallback means "not broken," not
 * "confirmed correct" -- see the SKY/skycoin comment in config/assets.ts.
 */
async function verifyAssetIdentity(
  asset: TrackedAsset,
  primarySnapshot: AssetSnapshot | undefined
): Promise<{ snapshot: AssetSnapshot | undefined; status: AssetVerificationStatus }> {
  if (symbolMatches(asset, primarySnapshot)) {
    return { snapshot: primarySnapshot, status: "verified" };
  }

  console.warn(
    `Identity check FAILED for ${asset.symbol} (coingeckoId="${asset.coingeckoId}"): ` +
      `${primarySnapshot ? `got symbol "${primarySnapshot.symbol}"` : "no snapshot returned"}, expected "${asset.symbol.toLowerCase()}".`
  );

  if (asset.fallbackCoingeckoId) {
    console.warn(`  -> trying fallback id "${asset.fallbackCoingeckoId}" for ${asset.symbol}...`);
    const fallbackSnapshot = await fetchSingleSnapshot(asset.fallbackCoingeckoId);
    if (symbolMatches(asset, fallbackSnapshot)) {
      console.warn(
        `  -> fallback "${asset.fallbackCoingeckoId}" passes the symbol check for ${asset.symbol}. ` +
          `Using it for this run, but a passing check is NOT proof this is the correct token for a ` +
          `real ticker collision -- confirm by hand before trusting this long-term (see config/assets.ts).`
      );
      return { snapshot: fallbackSnapshot, status: "verified" };
    }
    console.warn(
      `  -> fallback "${asset.fallbackCoingeckoId}" also failed the symbol check for ${asset.symbol}. Scrapping this run.`
    );
  } else {
    console.warn(`  -> no fallbackCoingeckoId configured for ${asset.symbol}. Scrapping this run.`);
  }

  return { snapshot: undefined, status: "conflict" };
}

async function main() {
  const needsVerification = getAssetsNeedingVerification();
  if (needsVerification.length > 0) {
    console.warn(
      "The following assets are flagged for manual id verification " +
        "(see apps/ingestion/src/config/assets.ts) -- runtime identity " +
        "checks run automatically below, but a passing check on a real " +
        "ticker collision is not the same as a human-confirmed correct id:",
      needsVerification.map((a) => `${a.symbol} -> ${a.coingeckoId}`).join(", ")
    );
  }

  console.log(`Fetching current snapshots for ${TRACKED_ASSETS.length} assets...`);
  const snapshots = await fetchCurrentSnapshots(TRACKED_ASSETS.map((a) => a.coingeckoId));

  const conflicts: string[] = [];

  for (const asset of TRACKED_ASSETS) {
    const primarySnapshot = snapshots.get(asset.coingeckoId);
    const { snapshot, status } = await verifyAssetIdentity(asset, primarySnapshot);
    await upsertAsset(asset, snapshot, status);

    if (status === "conflict") {
      conflicts.push(asset.symbol);
      // Scrapped: no price history for this asset this run. Move on without
      // attempting fetchDailyCandles -- there's no verified source id to
      // fetch candles from.
      await sleep(PER_ASSET_DELAY_MS);
      continue;
    }

    const sourceId = snapshot!.coingeckoId; // verified -- either primary or fallback
    try {
      console.log(`Fetching daily candles for ${asset.symbol} (source: ${sourceId})...`);
      const candles = await fetchDailyCandles(sourceId);
      await upsertDailyCandles(asset.symbol, candles);
      console.log(`  -> upserted ${candles.length} daily candles for ${asset.symbol}`);
    } catch (err) {
      // One asset failing here (transient API error) shouldn't abort the
      // whole run -- log it and keep going so the other assets still get
      // ingested this run. Note this is a different failure mode than an
      // identity conflict -- the id verified fine, the candle fetch itself
      // just failed -- so this does NOT change verification_status.
      console.error(`  -> failed to fetch/upsert candles for ${asset.symbol}:`, err);
    }

    await sleep(PER_ASSET_DELAY_MS);
  }

  if (conflicts.length > 0) {
    console.warn(
      `\nThis run scrapped ${conflicts.length} asset(s) due to identity conflicts: ${conflicts.join(", ")}. ` +
        `Their assets.verification_status is set to 'conflict' -- check before treating their data as current.`
    );
  }

  console.log("Ingestion run complete.");
}

main()
  .catch((err) => {
    console.error("Ingestion run failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
