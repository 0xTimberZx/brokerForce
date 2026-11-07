// Pool token-identity verification -- the durable fix for symbol-spoofed
// impostor pools that clear the turnover filter. DEX search matches on token
// SYMBOL, and symbols aren't unique: a scam "LINK" on Solana reported $205M
// TVL while the real Chainlink token trades on Ethereum. Turnover alone
// can't separate that from a genuinely deep, quiet pool -- but the pool's
// token CONTRACT ADDRESS can: a real LINK pool trades a LINK address
// CoinGecko lists for Chainlink; the impostor trades some other mint.
//
// The registry is each asset's known-legit addresses (assets.contract_
// addresses, from CoinGecko's platforms map). Verdict rules, deliberately
// conservative -- reject only on PROOF of wrong identity, never on absence:
//
//   - verified     : the pool's two token addresses match the two assets'
//                    known-legit sets (in either order).
//   - rejected     : both addresses are present AND both assets have a
//                    non-empty registry, but they don't form a valid match
//                    -> at least one token is an impostor.
//   - unverifiable : missing addresses, or an asset with no registry (native
//                    L1s like BTC/ETH have no token contract) -> can't judge;
//                    the turnover plausibility filter remains the guard.

export type IdentityVerdict = "verified" | "rejected" | "unverifiable";

/**
 * Canonical on-chain forms of native assets whose CoinGecko `platforms`
 * contracts don't cover how they trade on their own chain (none at all for
 * BTC; only a legacy Ethereum ERC-20 for BNB and CRO). A native coin like BTC can't be verified by contract
 * address -- it isn't an ERC-20 -- so its identity check would always abstain,
 * leaving impostor "BTC" pools guarded only by the turnover filter. But BTC
 * *does* trade on DEXes as wrapped/pegged tokens with real, well-known
 * addresses (WBTC on Ethereum, BTCB on BNB Chain). Seeding those into the
 * registry lets pools of the wrapped forms verify as the native asset.
 *
 * Addresses are lowercased and chain-agnostic (matching ANY known-legit
 * address is the signal -- see migration 004's header and verifyPoolIdentity).
 * These are stable, high-value canonical contracts; hardcoded here rather than
 * sourced from CoinGecko because they belong to *other* coin listings
 * (wrapped-bitcoin, binance-bitcoin), not BTC's own.
 */
export const NATIVE_ASSET_FORMS: Record<string, string[]> = {
  BTC: [
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC -- Wrapped BTC (Ethereum)
    "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB -- Binance-Peg BTC (BNB Chain)
  ],
  // BNB and CRO DO have CoinGecko contracts, but only their old Ethereum
  // ERC-20s. On their own chains they trade as the wrapped native token, so
  // without these every WBNB (BNB Chain) / WCRO (Cronos) pool was "rejected"
  // against a verified quote token, and BNB/USDT showed only a thin Ethereum
  // pool despite deep PancakeSwap liquidity.
  BNB: [
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB -- Wrapped BNB (BNB Chain)
  ],
  CRO: [
    "0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23", // WCRO -- Wrapped CRO (Cronos)
  ],
  // AVAX has no CoinGecko contract at all, so its pools only ever abstained
  // ("unverifiable"). Seeding WAVAX lets them verify, the way WBTC does for BTC.
  AVAX: [
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX -- Wrapped AVAX (Avalanche C-Chain)
  ],
  // DOGE is native with no DEX of its own; its DEX liquidity is the
  // Binance-Peg DOGE BEP-20 (ticker "DOGE", so symbol matching already works).
  DOGE: [
    "0xba2ae424d960c26247dd6c32edc70b295c744c43", // Binance-Peg Dogecoin (BNB Chain)
  ],
  // The stables on BNB Chain are Binance-Peg tokens that CoinGecko lists as
  // separate coins, so they're missing from USDT's and USDC's own contract
  // lists. Without these, every BNB Chain pool quoted in USDT/USDC was
  // "rejected", whatever the other token was (WBNB/USDT included).
  USDT: [
    "0x55d398326f99059ff775485246999027b3197955", // Binance-Peg BSC-USD (BNB Chain)
  ],
  USDC: [
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // Binance-Peg USD Coin (BNB Chain)
  ],
};

export interface PoolAddresses {
  baseTokenAddress?: string;
  quoteTokenAddress?: string;
}

/** Registry of known-legit contract addresses per asset symbol. Sets are of
 * lowercased addresses; an empty/absent set means "no contract on record"
 * (native L1) -> that side abstains. */
export type ContractRegistry = Map<string, Set<string>>;

function norm(a: string | undefined): string | null {
  const s = a?.trim().toLowerCase();
  return s && s.length > 0 ? s : null;
}

/**
 * Verify a pool's tokens are the real assetA/assetB, given the registry.
 * assetA/assetB are the pair's canonical symbols.
 */
export function verifyPoolIdentity(
  pool: PoolAddresses,
  assetA: string,
  assetB: string,
  registry: ContractRegistry
): IdentityVerdict {
  const base = norm(pool.baseTokenAddress);
  const quote = norm(pool.quoteTokenAddress);
  if (!base || !quote) return "unverifiable"; // source gave no addresses

  const aSet = registry.get(assetA.toUpperCase());
  const bSet = registry.get(assetB.toUpperCase());
  // If either asset has no known contract (native L1, or registry not yet
  // populated), we can't prove or disprove identity -- abstain.
  if (!aSet || aSet.size === 0 || !bSet || bSet.size === 0) return "unverifiable";

  const matches =
    (aSet.has(base) && bSet.has(quote)) || (aSet.has(quote) && bSet.has(base));
  return matches ? "verified" : "rejected";
}
