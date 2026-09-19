// Orca Whirlpools REST client (spec 017, Phase 1) -- the Solana analogue of the
// Uniswap-v3 subgraph client. Orca Whirlpools are Solana's concentrated-liquidity
// (CLMM) pools; every Whirlpool is CLMM. Phase 1 fills ONE column the primary
// sources can't: fee_tier_verified (from the pool's real fee rate). The per-tick
// active_liquidity_distribution lives on-chain (TickArray accounts) and is Phase 2
// -- not fetched here.
//
// Endpoint (public, no key): GET https://api.orca.so/v2/solana/pools/{address}
// where {address} is the Whirlpool account pubkey (pools.pool_address on Solana).
// Egress to it is blocked from the analysis container but open on CI runners;
// exact response nesting + the feeRate encoding are probe-verified before merge
// (see specs/017-solana-enrichment/spec17.md).

const ORCA_API_BASE = "https://api.orca.so/v2/solana";
const REQUEST_TIMEOUT_MS = 10_000;

export interface OrcaPoolResult {
  // The pool's real fee tier, FRACTIONAL (0.0005 = 0.05%). null when the API
  // doesn't report a usable rate -> the caller leaves fee_tier_verified NULL.
  feeTierFractional: number | null;
}

/** PURE: Orca reports feeRate as hundredths of a basis point -- 100 = 1 bp =
 * 0.01% -- i.e. millionths, the SAME encoding as Uniswap's feeTier (500 ->
 * 0.0005, 3000 -> 0.003, 10000 -> 0.01). Convert to the fractional form the rest
 * of the codebase uses. Non-finite / <= 0 -> null. */
export function orcaFeeRateToFractional(raw: string | number | null | undefined): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 1_000_000;
}

// The v2 pool endpoint may return the pool object directly or wrapped in `data`;
// accept either so a nesting change doesn't silently null everything (the probe
// pins the real shape, this keeps us robust to it).
interface OrcaPoolBody {
  data?: { feeRate?: string | number | null } | null;
  feeRate?: string | number | null;
}

/** Thin client over Orca's public pools REST API. No API key required. */
export class OrcaWhirlpools {
  constructor(private readonly apiBase: string = ORCA_API_BASE) {}

  /** Enrich one Whirlpool by its on-chain address. Returns the fee tier, or null
   * when the API doesn't know the pool / errors -- the caller leaves the column
   * NULL rather than fabricating. Throws only on a transport failure the caller
   * wants counted. */
  async fetchPool(address: string): Promise<OrcaPoolResult | null> {
    const res = await fetch(`${this.apiBase}/pools/${address}`, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return null; // unknown pool -> leave columns NULL
    if (!res.ok) {
      throw new Error(`orca HTTP ${res.status} for pool ${address}`);
    }
    const body = (await res.json()) as OrcaPoolBody;
    const pool = body.data ?? body;
    if (!pool) return null;
    return { feeTierFractional: orcaFeeRateToFractional(pool.feeRate) };
  }
}
