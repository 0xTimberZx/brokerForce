// CoinGecko source for asset-level data. Two endpoints are needed and merged
// here because CoinGecko's free tier splits the data we need across them:
//
//   - /coins/markets        -> current snapshot: market cap, circulating
//                              supply, fully diluted valuation.
//   - /coins/{id}/ohlc      -> actual open/high/low/close candles.
//   - /coins/{id}/market_chart -> volume time series (the /ohlc endpoint
//                              does NOT include volume, only OHLC).
//
// CoinGecko's free tier auto-adjusts granularity based on the `days` window
// requested: short windows return intraday data, but anything requesting
// more than 90 days of history returns daily candles automatically. Since
// Database.md §2 has us on daily granularity for now, every call below
// requests more than 90 days specifically to guarantee that, not because we
// actually want 90+ days of history every time (DEFAULT_LOOKBACK_DAYS below
// controls how much we actually keep).
//
// Rate limits on the free tier are strict and have changed over time --
// verify current limits before running this against many assets back-to-back;
// REQUEST_DELAY_MS exists specifically to avoid tripping them, but the right
// value depends on whatever plan/key is actually in use.

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const MIN_DAYS_FOR_DAILY_GRANULARITY = 91; // must exceed 90 to guarantee daily candles
export const DEFAULT_LOOKBACK_DAYS = 200; // matches the largest canonical window (ORT.md §3)
const REQUEST_DELAY_MS = 1500; // conservative; tune to your actual CoinGecko plan's rate limit

export interface AssetSnapshot {
  coingeckoId: string;
  /** CoinGecko's own symbol field for this id -- the basis for runtime
   * identity verification in ingest-assets.ts. Lowercase, per CoinGecko's
   * convention (e.g. "btc", not "BTC"). */
  symbol: string;
  marketCap: number | null;
  circulatingSupply: number | null;
  fullyDilutedValue: number | null;
}

export interface DailyCandle {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CoinGecko request failed (${res.status}): ${url}`);
  }
  return res.json() as Promise<T>;
}

/** Current snapshot fields for the `assets` table. Call with all tracked ids
 * at once -- /coins/markets supports a comma-separated `ids` param, so this
 * is one request regardless of how many assets are tracked. */
export async function fetchCurrentSnapshots(
  coingeckoIds: string[]
): Promise<Map<string, AssetSnapshot>> {
  const url =
    `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${coingeckoIds.join(",")}` +
    `&order=market_cap_desc&per_page=250&page=1&sparkline=false`;

  type MarketsResponse = {
    id: string;
    symbol: string;
    market_cap: number | null;
    circulating_supply: number | null;
    fully_diluted_valuation: number | null;
  }[];

  const rows = await fetchJson<MarketsResponse>(url);
  const result = new Map<string, AssetSnapshot>();
  for (const row of rows) {
    result.set(row.id, {
      coingeckoId: row.id,
      symbol: row.symbol,
      marketCap: row.market_cap,
      circulatingSupply: row.circulating_supply,
      fullyDilutedValue: row.fully_diluted_valuation,
    });
  }
  return result;
}

/** Single-id snapshot lookup, used for verifying a fallbackCoingeckoId that
 * wasn't part of the original batch request -- e.g. the primary id for SKY
 * fails identity verification, so this fetches "skycoin" on its own to check
 * whether IT verifies, without re-fetching the other 19 assets. */
export async function fetchSingleSnapshot(
  coingeckoId: string
): Promise<AssetSnapshot | undefined> {
  const snapshots = await fetchCurrentSnapshots([coingeckoId]);
  return snapshots.get(coingeckoId);
}

export interface IdentityCheck {
  matches: boolean;
  returnedSymbol: string;
  returnedName: string;
}

/** Confirms a coingeckoId actually resolves to the token we think it does,
 * by checking the symbol CoinGecko returns against what we expect. This is
 * the real-time version of the manual verification flagged in
 * src/config/assets.ts -- run every ingestion run, not just once, since a
 * misconfigured id should never silently write wrong-token data. */
export async function verifyAssetIdentity(
  coingeckoId: string,
  expectedSymbol: string
): Promise<IdentityCheck> {
  const url = `${COINGECKO_BASE}/coins/${coingeckoId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
  const data = await fetchJson<{ symbol: string; name: string }>(url);
  return {
    matches: data.symbol.toUpperCase() === expectedSymbol.toUpperCase(),
    returnedSymbol: data.symbol.toUpperCase(),
    returnedName: data.name,
  };
}

function toDateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** Fetches and merges OHLC + volume into daily candles for one asset.
 * One asset per call (CoinGecko's per-asset endpoints don't support batching),
 * so callers fetching many assets should space these out -- see
 * REQUEST_DELAY_MS and the sleep() call in ingest-assets.ts's loop. */
export async function fetchDailyCandles(
  coingeckoId: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS
): Promise<DailyCandle[]> {
  const days = Math.max(lookbackDays, MIN_DAYS_FOR_DAILY_GRANULARITY);

  const ohlcUrl = `${COINGECKO_BASE}/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`;
  const ohlcRows = await fetchJson<[number, number, number, number, number][]>(ohlcUrl);

  await sleep(REQUEST_DELAY_MS);

  const chartUrl = `${COINGECKO_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const chart = await fetchJson<{ total_volumes: [number, number][] }>(chartUrl);

  const volumeByDate = new Map<string, number>();
  for (const [ts, volume] of chart.total_volumes) {
    volumeByDate.set(toDateKey(ts), volume);
  }

  const candles: DailyCandle[] = ohlcRows.map(([ts, open, high, low, close]) => {
    const date = toDateKey(ts);
    return {
      date,
      open,
      high,
      low,
      close,
      // Falls back to 0 rather than dropping the row if a date has no
      // matching volume entry -- this can happen at the edges of the window
      // due to how each endpoint buckets its last partial day slightly
      // differently. Flag rather than silently treat as a real zero-volume day
      // if this fallback triggers often; that would mean the merge logic
      // needs tightening, not that volume was actually zero.
      volume: volumeByDate.get(date) ?? 0,
    };
  });

  // Trim to the actually-requested lookback -- we over-fetched to guarantee
  // daily granularity (MIN_DAYS_FOR_DAILY_GRANULARITY), but callers asking
  // for less than that shouldn't get more rows back than they asked for.
  return candles.slice(-lookbackDays);
}
