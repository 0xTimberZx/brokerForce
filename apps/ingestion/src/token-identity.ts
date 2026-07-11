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
