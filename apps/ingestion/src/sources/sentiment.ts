// Sentiment sources -- the pluggable seam for market Fear & Greed providers,
// mirroring the PoolSource pattern (one interface, swappable implementations).
// Alternative.me is implemented now (keyless, full history back to 2018);
// CoinMarketCap and CFGI slot in later as new classes behind this same
// interface, no caller changes.

import type { MarketSentiment, SentimentClassification } from "@brokerforce/types";

export interface SentimentSource {
  /** Stable identifier stored in market_sentiment.source (e.g.
   * "alternative.me") -- distinguishes providers that coexist per date. */
  readonly id: string;
  /**
   * Fetch daily market-wide readings, oldest-first.
   * @param days how far back to fetch; 0 means the provider's FULL history
   *   (used for the first-run backfill). Providers without an all-history
   *   mode treat 0 as their max.
   */
  fetchDaily(days: number): Promise<MarketSentiment[]>;
}

const ALT_ME_BASE = "https://api.alternative.me";
const REQUEST_TIMEOUT_MS = 8_000;

const VALID_CLASSIFICATIONS: readonly SentimentClassification[] = [
  "Extreme Fear",
  "Fear",
  "Neutral",
  "Greed",
  "Extreme Greed",
];

/** Alternative.me returns the classification label directly; keep it verbatim
 * when it's one we recognize, otherwise derive from the numeric value so a
 * new/renamed label never drops a row. Their published bands:
 * 0-24 Extreme Fear, 25-49 Fear, 50 Neutral, 51-74 Greed, 75-100 Extreme Greed. */
export function normalizeClassification(raw: string | undefined, value: number): SentimentClassification {
  const trimmed = (raw ?? "").trim();
  if ((VALID_CLASSIFICATIONS as readonly string[]).includes(trimmed)) {
    return trimmed as SentimentClassification;
  }
  if (value <= 24) return "Extreme Fear";
  if (value <= 49) return "Fear";
  if (value === 50) return "Neutral";
  if (value <= 74) return "Greed";
  return "Extreme Greed";
}

interface AltMeEntry {
  value?: string;
  value_classification?: string;
  timestamp?: string; // unix seconds, UTC midnight
}

/** Pure transform of Alternative.me's `data` array into MarketSentiment rows,
 * newest-first from the API but returned oldest-first. Exported for unit
 * testing without a network call. Rows with an unparseable value or timestamp
 * are dropped (logged by the caller), never written as garbage. */
export function parseAltMeData(data: AltMeEntry[], sourceId: string): MarketSentiment[] {
  const rows: MarketSentiment[] = [];
  for (const entry of data) {
    const value = Number(entry.value);
    const tsSec = Number(entry.timestamp);
    if (!Number.isFinite(value) || value < 0 || value > 100 || !Number.isFinite(tsSec)) continue;
    const date = new Date(tsSec * 1000).toISOString().slice(0, 10);
    rows.push({
      source: sourceId,
      date,
      value: Math.round(value),
      classification: normalizeClassification(entry.value_classification, value),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export class AlternativeMeSentimentSource implements SentimentSource {
  readonly id = "alternative.me";
  constructor(private baseUrl: string = ALT_ME_BASE) {}

  async fetchDaily(days: number): Promise<MarketSentiment[]> {
    // limit=0 returns the entire history (~2018-present) in one call -- the
    // first-run backfill. A small positive limit is the daily top-up.
    const limit = days <= 0 ? 0 : days;
    const url = `${this.baseUrl}/fng/?limit=${limit}&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Alternative.me F&G request failed (${res.status})`);
    }
    const body = (await res.json()) as { data?: AltMeEntry[]; metadata?: { error?: string | null } };
    if (body.metadata?.error) {
      throw new Error(`Alternative.me F&G returned an error: ${body.metadata.error}`);
    }
    return parseAltMeData(body.data ?? [], this.id);
  }
}

/** The sources ingested by default. One today; the list is where CMC/CFGI
 * join once their keys exist -- the only place a new provider is registered.
 * ALT_ME_BASE_URL overrides Alternative.me's base (for a proxy or a test
 * double) -- unset in production, where the real public endpoint is used. */
export function defaultSentimentSources(): SentimentSource[] {
  const altBase = process.env.ALT_ME_BASE_URL;
  return [altBase ? new AlternativeMeSentimentSource(altBase) : new AlternativeMeSentimentSource()];
}
