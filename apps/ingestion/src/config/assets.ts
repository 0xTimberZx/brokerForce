// The 20 tracked assets, per docs/Glossary.md's Asset Class Tiers.
// (Glossary/Database.md say "~17" as a rough approximation -- the actual
// count is 20: 4 blue-chip + 5 stable + 6 growth-exotic + 5 degen.)
//
// IMPORTANT -- coingeckoId values below are my best-confidence mapping from
// training knowledge, NOT verified against a live API call (this environment
// has no network access). Several tickers have real collision risk on
// CoinGecko, where multiple unrelated tokens share a symbol.
//
// IDENTITY CONFLICT POLICY: any asset whose runtime identity check fails
// (see ../ingest-assets.ts -- it compares the CoinGecko response's `symbol`
// field against the expected ticker) is scrapped for that run -- no price
// data or snapshot is written using unverified data -- and replaced with
// fallbackCoingeckoId, if one is set. This automated check can confirm a
// BROKEN id (wrong/nonexistent id, response symbol doesn't match at all),
// but it can NOT fully resolve a true ticker COLLISION (two real, unrelated
// projects legitimately sharing the same ticker) -- both candidates could
// return a matching symbol and pass the check equally. That case still
// needs a human to confirm once; a passing fallback here is not proof it's
// the *correct* one, just that it isn't *broken*.
//
//   - SKY: a genuine collision, not just an uncertain id -- could resolve to
//     Sky (the MakerDAO/MKR rebrand) or the unrelated, older Skycoin
//     project. "skycoin" is set as the fallback candidate below, but
//     because this is a real collision (not a broken-id case), a human
//     should confirm which one is actually wanted before trusting either.
//   - WIF: lower risk -- "dogwifcoin" is the dominant listing for $WIF as of
//     training data. No fallback candidate set; if this id turns out wrong
//     it's more likely a simple wrong-id error than a real collision, so a
//     failed check should scrap and prompt a human to find the right id,
//     not guess at a fallback I'm not confident in.
//   - MEME: a generic, frequently-reused ticker. "memecoin" is the
//     best-confidence guess. No fallback candidate set, same reasoning as
//     WIF -- I don't have a specific, confident alternate id to offer.
//
// Before running real ingestion, verify every id (and SKY's fallback choice
// specifically) against https://api.coingecko.com/api/v3/coins/list.

import type { AssetClass } from "@brokerforce/types";

export interface TrackedAsset {
  symbol: string;
  class: AssetClass;
  coingeckoId: string;
  /** Set true if this id needs manual verification before trusting ingested data. */
  verifyId?: boolean;
  /**
   * Policy: any asset whose coingeckoId fails identity verification at
   * ingestion time is scrapped (no price data written) for that run. If a
   * fallbackCoingeckoId is set, the ingestion script retries verification
   * against it before scrapping -- if the fallback verifies, that asset is
   * sourced from the fallback id going forward (logged clearly either way).
   *
   * Deliberately left undefined for WIF/MEME below rather than guessing a
   * second unverified id on top of the first unverified one -- that would
   * just be the same problem twice. Fill these in once you've manually
   * confirmed a real alternate id for a given asset, if one exists.
   */
  fallbackCoingeckoId?: string;
}

export const TRACKED_ASSETS: TrackedAsset[] = [
  // Blue chip
  { symbol: "BTC", class: "blue-chip", coingeckoId: "bitcoin" },
  { symbol: "ETH", class: "blue-chip", coingeckoId: "ethereum" },
  { symbol: "BNB", class: "blue-chip", coingeckoId: "binancecoin" },
  { symbol: "SOL", class: "blue-chip", coingeckoId: "solana" },

  // Stable
  { symbol: "USDC", class: "stable", coingeckoId: "usd-coin" },
  { symbol: "USDT", class: "stable", coingeckoId: "tether" },
  { symbol: "FRAX", class: "stable", coingeckoId: "frax" },
  {
    symbol: "SKY",
    class: "stable",
    coingeckoId: "sky",
    verifyId: true,
    fallbackCoingeckoId: "skycoin",
  },
  { symbol: "DAI", class: "stable", coingeckoId: "dai" },

  // Growth / exotic
  { symbol: "ONDO", class: "growth-exotic", coingeckoId: "ondo-finance" },
  { symbol: "NEAR", class: "growth-exotic", coingeckoId: "near" },
  { symbol: "LINK", class: "growth-exotic", coingeckoId: "chainlink" },
  { symbol: "AAVE", class: "growth-exotic", coingeckoId: "aave" },
  { symbol: "AVAX", class: "growth-exotic", coingeckoId: "avalanche-2" },
  { symbol: "ARB", class: "growth-exotic", coingeckoId: "arbitrum" },

  // Degen
  { symbol: "PEPE", class: "degen", coingeckoId: "pepe" },
  { symbol: "BONK", class: "degen", coingeckoId: "bonk" },
  { symbol: "WIF", class: "degen", coingeckoId: "dogwifcoin", verifyId: true },
  { symbol: "FLOKI", class: "degen", coingeckoId: "floki" },
  { symbol: "MEME", class: "degen", coingeckoId: "memecoin", verifyId: true },
];

export function getAssetsNeedingVerification(): TrackedAsset[] {
  return TRACKED_ASSETS.filter((a) => a.verifyId);
}
