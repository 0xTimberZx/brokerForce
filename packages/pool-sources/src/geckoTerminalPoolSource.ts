// GeckoTerminal implementation of PoolSource -- the first real pool data
// source. Chosen per the source decision discussed against spec5.md's
// requirements: free, no API key, covers 200+ networks / 1,500+ DEXes, and
// its public rate limit (~30 calls/min) is comfortably above what the
// 10-minute live-fetch cache in poolService.ts can generate.
//
// What GeckoTerminal can and can't provide, mapped honestly onto
// RawPoolData:
//
//   - tvl              <- attributes.reserve_in_usd
//   - volume           <- attributes.volume_usd.h24
//   - feeTier          <- parsed from the pool name ("WETH / USDC 0.05%");
//                         0 when the name carries no fee, meaning UNKNOWN,
//                         not free -- GeckoTerminal has no structured fee
//                         field, and v2-style DEX pools often omit it.
//   - activeLiquidity  <- null: not exposed by this API.
//   - swapCount7d, uniqueLpCount, activeLiquidityDistribution <- omitted:
//     tick-level and LP-level data needs a subgraph source (e.g. a future
//     UniswapSubgraphPoolSource) -- deliberately NOT approximated from the
//     24h transaction counts GeckoTerminal does return.

import type { PoolSource, PoolQuery, RawPoolData } from "./poolSource.js";
import { PoolSourceUnavailableError } from "./poolSource.js";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const REQUEST_TIMEOUT_MS = 5_000; // per PoolSource's contract / spec5.md
const MAX_POOLS = 20; // search relevance degrades fast past the top page

// relationships (and each relationship's data) are OPTIONAL: the first
// automated ingestion run crashed on a live search response where
// `relationships.dex` was absent -- the API does not guarantee these objects
// on every item, so nothing below may assume them.
interface GtPoolItem {
  id: string;
  attributes: {
    name: string;
    reserve_in_usd: string | null;
    volume_usd?: { h24: string | null };
  };
  relationships?: {
    dex?: { data?: { id: string } | null };
    network?: { data?: { id: string } | null };
  };
}

interface GtSearchResponse {
  data: GtPoolItem[];
}

/** "WETH / USDC 0.05%" -> ["WETH", "USDC"], 0.0005. Fee absent -> 0 (unknown). */
export function parsePoolName(name: string): { symbols: string[]; feeTier: number } {
  const feeMatch = name.match(/(\d+(?:\.\d+)?)\s*%\s*$/);
  const feeTier = feeMatch?.[1] ? Number(feeMatch[1]) / 100 : 0;
  const withoutFee = feeMatch ? name.slice(0, feeMatch.index) : name;
  const symbols = withoutFee
    .split("/")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return { symbols, feeTier };
}

/** Symbol equality that treats canonical wrapped forms as the same asset --
 * pairs are stored as "ETH"/"BTC" (Glossary.md asset symbols) but on-chain
 * pools trade the wrapped token, so GeckoTerminal reports "WETH"/"WBTC". */
export function symbolsMatch(poolSymbol: string, assetSymbol: string): boolean {
  const p = poolSymbol.toUpperCase();
  const a = assetSymbol.toUpperCase();
  return p === a || p === `W${a}` || `W${p}` === a;
}

function toNumberOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class GeckoTerminalPoolSource implements PoolSource {
  constructor(private baseUrl: string = GECKOTERMINAL_BASE) {}

  async fetchPoolsForPair(query: PoolQuery): Promise<RawPoolData[]> {
    const params = new URLSearchParams({
      query: `${query.pairAssetA} ${query.pairAssetB}`,
      page: "1",
      // Ask for the relationship objects explicitly -- without this the
      // search response may omit them entirely (see GtPoolItem's comment).
      include: "dex,network",
    });
    // GeckoTerminal's search accepts a network filter directly; dex/feeTier/
    // minTvl filtering happens downstream in poolService.applyFilters, which
    // runs on every live-fetch result anyway (AND semantics per spec5.md).
    if (query.chain) params.set("network", query.chain);

    const url = `${this.baseUrl}/search/pools?${params.toString()}`;
    let body: GtSearchResponse;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new PoolSourceUnavailableError(`GeckoTerminal request failed (${res.status})`);
      }
      body = (await res.json()) as GtSearchResponse;
    } catch (err) {
      if (err instanceof PoolSourceUnavailableError) throw err;
      // fetch network failures, AbortSignal timeouts, and malformed-JSON
      // bodies all mean the same thing to the caller: no data right now.
      const reason = err instanceof Error ? err.message : String(err);
      throw new PoolSourceUnavailableError(`GeckoTerminal unreachable: ${reason}`);
    }

    const pools: RawPoolData[] = [];
    for (const item of body.data ?? []) {
      const { symbols, feeTier } = parsePoolName(item.attributes.name);
      // Search is fuzzy -- "ETH USDC" also surfaces ETH/USDT etc. Keep only
      // pools whose two sides are exactly this pair, in either order.
      const isThisPair =
        symbols.length === 2 &&
        ((symbolsMatch(symbols[0] ?? "", query.pairAssetA) && symbolsMatch(symbols[1] ?? "", query.pairAssetB)) ||
          (symbolsMatch(symbols[0] ?? "", query.pairAssetB) && symbolsMatch(symbols[1] ?? "", query.pairAssetA)));
      if (!isThisPair) continue;

      pools.push({
        dex: item.relationships?.dex?.data?.id ?? "unknown",
        chain: item.relationships?.network?.data?.id ?? "unknown",
        feeTier,
        tvl: toNumberOrNull(item.attributes.reserve_in_usd),
        volume: toNumberOrNull(item.attributes.volume_usd?.h24),
        activeLiquidity: null, // not exposed by GeckoTerminal -- see header
      });
      if (pools.length >= MAX_POOLS) break;
    }
    return pools;
  }
}
