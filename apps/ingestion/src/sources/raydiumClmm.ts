// Raydium REST client (spec 017, Phase 1). Raydium's pools are HETEROGENEOUS:
// Concentrated (CLMM, Uniswap-v3-style ticks) vs Standard (AMM-v4 / CPMM,
// constant-product). We enrich fee_tier_verified for BOTH (a real fee tier is
// honest for either), but only CLMM pools are concentrated, so only they get
// pool_version='clmm'. The per-tick distribution (CLMM only) is on-chain and is
// Phase 2 -- not fetched here.
//
// Endpoint (public, no key): GET https://api-v3.raydium.io/pools/info/ids?ids={id}
// where {id} is the pool account pubkey (pools.pool_address on Solana). Egress is
// blocked from the analysis container but open on CI runners; the exact fee
// encoding + the `type` values are probe-verified before merge (see spec17.md).

const RAYDIUM_API_BASE = "https://api-v3.raydium.io";
const REQUEST_TIMEOUT_MS = 10_000;

export type RaydiumPoolKind = "clmm" | "standard" | "other";

export interface RaydiumPoolResult {
  poolKind: RaydiumPoolKind;
  // Real fee tier, FRACTIONAL (0.0025 = 0.25%). null when unusable.
  feeTierFractional: number | null;
}

/** PURE: map Raydium's `type` string to our kinds. "Concentrated" -> clmm
 * (tick-based, gets pool_version='clmm'); "Standard" -> standard (constant
 * product, fee only, no pool_version); anything else -> other (skipped). */
export function classifyRaydiumType(type: string | null | undefined): RaydiumPoolKind {
  const t = (type ?? "").toLowerCase();
  if (t === "concentrated") return "clmm";
  if (t === "standard") return "standard";
  return "other";
}

interface RaydiumPoolEntry {
  type?: string | null;
  // api-v3 may express the fee either as a ready fractional (`feeRate`, e.g.
  // 0.0025) or as millionths on the CLMM config (`config.tradeFeeRate`, e.g.
  // 2500). Handle both so an encoding we didn't pin doesn't silently zero fees.
  feeRate?: string | number | null;
  config?: { tradeFeeRate?: string | number | null } | null;
  ammConfig?: { tradeFeeRate?: string | number | null } | null;
}

/** PURE: derive {kind, fee} from one api-v3 pool entry. Fee resolution order:
 * CLMM config tradeFeeRate (millionths) -> a sub-1 `feeRate` (already fractional)
 * -> a >=1 `feeRate` (millionths). Non-finite / <=0 everywhere -> null. */
export function parseRaydiumPool(entry: RaydiumPoolEntry | null | undefined): RaydiumPoolResult {
  if (!entry) return { poolKind: "other", feeTierFractional: null };
  const poolKind = classifyRaydiumType(entry.type);
  const tradeFeeRate = entry.config?.tradeFeeRate ?? entry.ammConfig?.tradeFeeRate;
  let fee: number | null = null;
  const tfr = Number(tradeFeeRate);
  const fr = Number(entry.feeRate);
  if (Number.isFinite(tfr) && tfr > 0) {
    fee = tfr / 1_000_000;
  } else if (Number.isFinite(fr) && fr > 0) {
    fee = fr < 1 ? fr : fr / 1_000_000;
  }
  return { poolKind, feeTierFractional: fee };
}

interface RaydiumIdsBody {
  success?: boolean;
  data?: (RaydiumPoolEntry | null)[] | null;
}

/** Thin client over Raydium's public api-v3. No API key required. */
export class RaydiumClmm {
  constructor(private readonly apiBase: string = RAYDIUM_API_BASE) {}

  /** Enrich one pool by its account id. Returns {kind, fee}, or null when the
   * API returns no entry for the id / errors -- caller leaves columns NULL.
   * Throws only on a transport failure the caller wants counted. */
  async fetchPool(id: string): Promise<RaydiumPoolResult | null> {
    const res = await fetch(`${this.apiBase}/pools/info/ids?ids=${id}`, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`raydium HTTP ${res.status} for pool ${id}`);
    }
    const body = (await res.json()) as RaydiumIdsBody;
    const entry = body.data?.[0];
    if (!entry) return null; // unknown id (api-v3 returns [null] for misses)
    return parseRaydiumPool(entry);
  }
}
