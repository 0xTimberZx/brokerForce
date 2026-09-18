// Uniswap-v3 subgraph client (spec 012) -- the WRITE side of pool enrichment.
//
// This is deliberately NOT a PoolSource in defaultPoolSource()'s fallback
// chain: that chain is first-wins/no-merge and DexScreener already wins
// wholesale, and the subgraph only knows Uniswap-v3 pools, not the full
// multi-DEX universe. Instead the enrichment step (enrich-pools-subgraph.ts)
// calls this per already-ingested v3 pool to fill three columns the primary
// sources can't: active_liquidity_distribution, swap_count_7d (and
// unique_lp_count, which the subgraph doesn't expose -- see below).
//
// Everything here was verified against the live gateway by a throwaway CI
// probe (see specs/012-subgraph-enrichment/spec12.md "Discovery-probe
// results"): the per-chain deployment IDs resolve; poolDayDatas is a
// TOP-LEVEL entity returning PER-DAY txCount (so swap_count_7d = Σ of 7 days);
// pool.liquidityProviderCount is 0 everywhere (why unique_lp_count stays
// deferred); pool.ticks give tickIdx / liquidityGross / price0.

// (chain, dex) -> v3(-schema) subgraph deployment ID on The Graph decentralized
// network, keyed "${chain}:${dex}" (see subgraphKey). Spec 012 routed by chain
// alone; spec 016 routes by (chain, dex) so the Uniswap-v3-*fork* DEXs on a chain
// (PancakeSwap v3, Pharaoh v3) enrich through this same client -- they share the
// v3 subgraph schema (pool.ticks / poolDayDatas), only the deployment differs.
//
// Only probe-verified, healthy deployments belong here; a (chain, dex) absent
// from this map is simply not enriched (optimism's published Uniswap ID was
// unhealthy on the network at probe time -- "bad indexers" -- so it's omitted
// until a healthy one is confirmed). canonicalChain() (spec 011) guarantees
// pools.chain uses exactly these chain keys; pools.dex holds the source-reported
// DEX slug (e.g. "uniswap", "pancakeswap", "pharaoh").
export const V3_SUBGRAPH_IDS: Readonly<Record<string, string>> = {
  "ethereum:uniswap": "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
  "arbitrum:uniswap": "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM",
  "polygon:uniswap": "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
  "base:uniswap": "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG",
  "bsc:uniswap": "F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2",
  // spec 016: PancakeSwap v3 on BSC -- CI-probe-confirmed healthy + full
  // Uniswap-v3 schema parity (feeTier + ticks + per-day poolDayDatas) against a
  // real BSC pool. This is the slice's big win: 17 pancake-v3 pools, plus the 19
  // untagged bsc:uniswap pools the broadened selection now reaches through the
  // existing bsc:uniswap deployment (also re-confirmed by the probe).
  "bsc:pancakeswap": "Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ",
  // AVALANCHE -- DEFERRED (probe finding 2026-09-18): the only Uniswap-v3
  // Avalanche subgraph on the decentralized network (3Pwd3cqFKbqKAy...MxebD)
  // uses a Messari-standardised schema -- `Type Query has no field pool` -- not
  // the Uniswap-v3 schema enrichPool needs, so it's omitted rather than routed
  // to a query it can't answer. Avalanche's tick cohort is small anyway (2
  // uniswap + 2 pharaoh pools; its volume is Trader-Joe/Liquidity-Book bins,
  // which no v3 subgraph can express). Add "avalanche:uniswap" here once a
  // Uniswap-v3-schema deployment is confirmed, or via a Messari-schema adapter
  // (its own effort). Pharaoh (Ramses fork) likewise deferred: no discoverable
  // deployment + likely schema divergence.
};

/** PURE: the lookup key for V3_SUBGRAPH_IDS. Lower-cased so a source that reports
 * "Uniswap"/"PancakeSwap" still matches; canonicalChain already lower-cases the
 * chain, but we normalise both sides so the map's contract is unambiguous. */
export function subgraphKey(chain: string, dex: string): string {
  return `${chain.toLowerCase()}:${dex.toLowerCase()}`;
}

const GATEWAY_BASE = "https://gateway.thegraph.com/api";
const REQUEST_TIMEOUT_MS = 10_000;

// How many of the most-liquid initialized ticks to keep per pool. The probe
// showed a handful of ticks hold the overwhelming majority of a pool's
// liquidity; 40 comfortably captures the meaningful concentrations while
// keeping the JSONB column (and the PoolDetailPanel bar chart) small.
const MAX_TICKS = 40;

export interface RawTick {
  tickIdx: string | number;
  liquidityGross: string | number;
  price0: string | number;
}

export interface RawPoolDayData {
  txCount?: string | number;
}

export interface SubgraphPoolResult {
  swapCount7d: number | null;
  activeLiquidityDistribution: { priceTick: number; liquidity: number }[];
  // The pool's real fee tier, FRACTIONAL (0.0005 = 0.05%), from pool.feeTier.
  // null when the subgraph doesn't report it -> the caller leaves
  // pools.fee_tier_verified NULL and consumers fall back to fee_tier (spec 013).
  feeTierFractional: number | null;
}

/** PURE: the Uniswap-v3 subgraph reports pool.feeTier as an integer in
 * millionths (500 = 0.05%, 3000 = 0.3%, 10000 = 1% -- probe-confirmed). Convert
 * to the FRACTIONAL form the rest of the codebase uses for fee_tier (500 ->
 * 0.0005), so no consumer needs a unit conversion. Non-finite / <= 0 -> null. */
export function feeTierToFractional(raw: string | number | null | undefined): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 1_000_000;
}

/** PURE: sum per-day txCount over the (up to 7) poolDayDatas rows. Returns null
 * when there are no rows at all (a real gap, distinct from a measured 0); rows
 * with an unparseable count are skipped, never counted as garbage. Verified by
 * the probe to be per-day, not cumulative. */
export function sumSwapCounts(dayDatas: RawPoolDayData[]): number | null {
  if (!dayDatas || dayDatas.length === 0) return null;
  let total = 0;
  let counted = 0;
  for (const d of dayDatas) {
    const n = Number(d.txCount);
    if (Number.isFinite(n) && n >= 0) {
      total += n;
      counted++;
    }
  }
  return counted === 0 ? null : total;
}

/** PURE: shape raw subgraph ticks into the JSONB column's
 * [{priceTick, liquidity}] form (already consumed by PoolDetailPanel).
 * liquidityGross/price0 are BigInt/decimal STRINGS from the subgraph; cast to
 * Number for a display column (precision loss is irrelevant for a bar height).
 * Drops non-finite / non-positive-liquidity ticks, keeps the MAX_TICKS most
 * liquid, then sorts by tickIdx so the chart reads left->right in price order. */
export function ticksToDistribution(ticks: RawTick[], cap = MAX_TICKS): { priceTick: number; liquidity: number }[] {
  if (!ticks || ticks.length === 0) return [];
  const mapped = ticks
    .map((t) => ({
      tickIdx: Number(t.tickIdx),
      priceTick: Number(t.price0),
      liquidity: Number(t.liquidityGross),
    }))
    .filter((t) => Number.isFinite(t.tickIdx) && Number.isFinite(t.priceTick) && Number.isFinite(t.liquidity) && t.liquidity > 0);
  // Keep the most-liquid `cap` ticks, then present them in price order.
  mapped.sort((a, b) => b.liquidity - a.liquidity);
  const top = mapped.slice(0, cap);
  top.sort((a, b) => a.tickIdx - b.tickIdx);
  return top.map((t) => ({ priceTick: t.priceTick, liquidity: t.liquidity }));
}

interface GqlResponse {
  data?: {
    pool?: { tick?: number | null; feeTier?: string | number | null; ticks?: RawTick[] } | null;
    poolDayDatas?: RawPoolDayData[];
  };
  errors?: { message: string }[];
}

// One request per pool: pool.feeTier + pool.ticks (top by liquidity) + top-level
// poolDayDatas for the pool (per-day txCount). liquidityProviderCount is
// intentionally NOT requested -- the probe confirmed it's always 0.
const POOL_ENRICH_QUERY = `
query Enrich($id: ID!, $addr: String!) {
  pool(id: $id) {
    tick
    feeTier
    ticks(first: ${MAX_TICKS}, orderBy: liquidityGross, orderDirection: desc) {
      tickIdx
      liquidityGross
      price0
    }
  }
  poolDayDatas(first: 7, orderBy: date, orderDirection: desc, where: { pool: $addr }) {
    txCount
  }
}`;

/** Thin client over one chain's v3 subgraph deployment. Constructed only when
 * GRAPH_API_KEY is present and the chain has a known deployment. */
export class UniswapV3Subgraph {
  private readonly url: string;

  constructor(
    apiKey: string,
    private readonly deploymentId: string,
    gatewayBase: string = GATEWAY_BASE
  ) {
    this.url = `${gatewayBase}/${apiKey}/subgraphs/id/${deploymentId}`;
  }

  /** Construct the client for a pool's (chain, dex), or null when that pair has
   * no mapped v3 subgraph -- the caller then skips the pool (degrade-safe). */
  static forChainDex(chain: string, dex: string, apiKey: string, gatewayBase?: string): UniswapV3Subgraph | null {
    const id = V3_SUBGRAPH_IDS[subgraphKey(chain, dex)];
    return id ? new UniswapV3Subgraph(apiKey, id, gatewayBase) : null;
  }

  /** Enrich one pool by its on-chain address. Returns the two derived fields,
   * or null when the subgraph doesn't know the pool / the endpoint errors --
   * the caller leaves the DB columns untouched (NULL) rather than fabricating.
   * Throws only on a transport failure the caller wants counted. */
  async enrichPool(address: string): Promise<SubgraphPoolResult | null> {
    const addr = address.toLowerCase();
    const res = await fetch(this.url, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: POOL_ENRICH_QUERY, variables: { id: addr, addr } }),
    });
    if (!res.ok) {
      throw new Error(`subgraph HTTP ${res.status} for deployment ${this.deploymentId}`);
    }
    const body = (await res.json()) as GqlResponse;
    if (body.errors && body.errors.length > 0) {
      // A GraphQL error (e.g. "bad indexers") is a transient/availability
      // problem, not our data -- surface it so the caller counts + skips.
      throw new Error(`subgraph query error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    const pool = body.data?.pool;
    if (!pool) return null; // subgraph doesn't know this pool -> leave columns NULL
    return {
      swapCount7d: sumSwapCounts(body.data?.poolDayDatas ?? []),
      activeLiquidityDistribution: ticksToDistribution(pool.ticks ?? []),
      feeTierFractional: feeTierToFractional(pool.feeTier),
    };
  }
}
