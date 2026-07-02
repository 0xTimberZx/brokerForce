import { query } from "@brokerforce/db";
import type { AssetVerificationStatus } from "@brokerforce/types";
import type { AssetSnapshot, DailyCandle } from "../sources/coingecko.js";
import type { TrackedAsset } from "../config/assets.js";

export async function upsertAsset(
  asset: TrackedAsset,
  snapshot: AssetSnapshot | undefined,
  verificationStatus: AssetVerificationStatus
): Promise<void> {
  await query(
    `INSERT INTO assets (symbol, class, market_cap, circulating_supply, fully_diluted_value, verification_status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (symbol) DO UPDATE SET
       class = EXCLUDED.class,
       -- On conflict (verificationStatus = 'conflict'), deliberately do NOT
       -- overwrite market_cap/circulating_supply/fully_diluted_value with
       -- the unverified snapshot -- keep whatever was last verified instead
       -- of replacing good data with data we just decided not to trust.
       market_cap = CASE WHEN $6 = 'conflict' THEN assets.market_cap ELSE EXCLUDED.market_cap END,
       circulating_supply = CASE WHEN $6 = 'conflict' THEN assets.circulating_supply ELSE EXCLUDED.circulating_supply END,
       fully_diluted_value = CASE WHEN $6 = 'conflict' THEN assets.fully_diluted_value ELSE EXCLUDED.fully_diluted_value END,
       verification_status = EXCLUDED.verification_status,
       updated_at = now()`,
    [
      asset.symbol,
      asset.class,
      snapshot?.marketCap ?? null,
      snapshot?.circulatingSupply ?? null,
      snapshot?.fullyDilutedValue ?? null,
      verificationStatus,
    ]
  );
}

export async function upsertDailyCandles(
  assetSymbol: string,
  candles: DailyCandle[]
): Promise<void> {
  // Plain per-row upserts, not a multi-row INSERT, since lookback windows are
  // small (≤200 rows per asset per run) and this only runs once daily per
  // asset -- not worth the complexity of batching until ingestion frequency
  // or asset count grows enough that this loop is measurably slow.
  for (const candle of candles) {
    await query(
      `INSERT INTO asset_price_history (asset_symbol, "timestamp", open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (asset_symbol, "timestamp") DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         volume = EXCLUDED.volume`,
      [
        assetSymbol,
        `${candle.date}T00:00:00Z`,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      ]
    );
  }
}
