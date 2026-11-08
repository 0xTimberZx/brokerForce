// DexScreener implementation of PoolSource -- added after the first
// automated GeckoTerminal-only runs got 429'd into uselessness from GitHub
// Actions: runners share egress IPs, and GeckoTerminal's ~30 calls/min
// public limit is exhausted by other tenants before our first call.
// DexScreener's DEX/pairs endpoints allow 300 requests/min -- 10x the
// headroom -- with no API key, and its search response carries structured
// baseToken/quoteToken symbols, so pair matching doesn't depend on parsing
// display names.
//
// Mapping onto RawPoolData, honestly:
//
//   - tvl              <- liquidity.usd (pooled liquidity in USD -- the
//                         closest DexScreener field to TVL)
//   - volume           <- volume.h24
//   - feeTier          <- parsed from labels when one is a percentage
//                         (e.g. "0.3%"); 0 = UNKNOWN otherwise -- most
//                         DexScreener labels are version tags ("v3"), not
//                         fees.
//   - activeLiquidity, swapCount7d, uniqueLpCount, distribution <- absent,
//     same reasoning as the GeckoTerminal source: subgraph territory.

import type { PoolSource, PoolQuery, RawPoolData } from "./poolSource.js";
import { PoolSourceUnavailableError } from "./poolSource.js";
import { symbolsMatch } from "./geckoTerminalPoolSource.js";
import { canonicalChain, versionFromLabels, validatePoolAddress } from "./normalize.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const REQUEST_TIMEOUT_MS = 5_000; // per PoolSource's contract / spec5.md
const MAX_POOLS = 20;

interface DsPair {
  chainId?: string;
  dexId?: string;
  // The pool's on-chain contract address (DexScreener's pair contract).
  pairAddress?: string;
  labels?: string[];
  baseToken?: { symbol?: string; address?: string };
  quoteToken?: { symbol?: string; address?: string };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
}

interface DsSearchResponse {
  pairs?: DsPair[] | null;
}

/** First percentage-shaped label wins: ["v3", "0.3%"] -> 0.003. None -> 0 (unknown). */
export function feeTierFromLabels(labels: string[] | undefined): number {
  for (const label of labels ?? []) {
    const m = label.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (m?.[1]) return Number(m[1]) / 100;
  }
  return 0;
}

/** Native coins whose DEX liquidity trades as a wrapped token under its own
 * ticker. symbolsMatch already treats these as the same asset; this only
 * widens the search so their pools are found in the first place. */
const WRAPPED_SEARCH_SYMBOL: Record<string, string> = {
  BTC: "WBTC",
  ETH: "WETH",
  BNB: "WBNB",
  AVAX: "WAVAX",
  CRO: "WCRO",
};

/** The plain "A B" search, then one with each side's wrapped symbol (if any). */
export function searchQueriesFor(a: string, b: string): string[] {
  const wa = WRAPPED_SEARCH_SYMBOL[a.toUpperCase()];
  const wb = WRAPPED_SEARCH_SYMBOL[b.toUpperCase()];
  const queries = [`${a} ${b}`];
  if (wa) queries.push(`${wa} ${b}`);
  if (wb) queries.push(`${a} ${wb}`);
  if (wa && wb) queries.push(`${wa} ${wb}`);
  return queries;
}

function toFiniteOrNull(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export class DexScreenerPoolSource implements PoolSource {
  constructor(private baseUrl: string = DEXSCREENER_BASE) {}

  async fetchPoolsForPair(query: PoolQuery): Promise<RawPoolData[]> {
    // The plain search ("BNB USDT") can miss a pair's main pool entirely:
    // DexScreener returns ~30 results, and for common symbols they fill up
    // with lookalike tokens. The deep PancakeSwap WBNB/USDT pool never showed
    // up that way. So pairs involving a native coin are also searched under
    // the wrapped symbol ("WBNB USDT") and the results merged. The first
    // search must succeed (its failure is the source being unavailable);
    // a failed extra search just contributes nothing.
    const queries = searchQueriesFor(query.pairAssetA, query.pairAssetB);
    const results: DsPair[][] = [];
    for (const [i, q] of queries.entries()) {
      try {
        results.push(await this.search(q));
      } catch (err) {
        if (i === 0) throw err;
        results.push([]);
      }
    }
    // Wrapped-symbol results first, then the plain search: a canonical
    // wrapped token is far harder to impersonate than a bare ticker, and the
    // plain results can be dozens of lookalikes (some claiming $600M TVL)
    // that would otherwise fill the MAX_POOLS cap before the real pool.
    const merged = new Map<string, DsPair>();
    for (const pair of [...results.slice(1).flat(), ...(results[0] ?? [])]) {
      const key = pair.pairAddress
        ? `${pair.chainId ?? ""}|${pair.pairAddress.toLowerCase()}`
        : JSON.stringify(pair);
      if (!merged.has(key)) merged.set(key, pair);
    }
    const body: DsSearchResponse = { pairs: [...merged.values()] };

    const pools: RawPoolData[] = [];
    for (const pair of body.pairs ?? []) {
      const base = pair.baseToken?.symbol ?? "";
      const quote = pair.quoteToken?.symbol ?? "";
      // Structured symbols, matched in either order; wrapped forms count as
      // their canonical asset (same policy as the GeckoTerminal source).
      const isThisPair =
        (symbolsMatch(base, query.pairAssetA) && symbolsMatch(quote, query.pairAssetB)) ||
        (symbolsMatch(base, query.pairAssetB) && symbolsMatch(quote, query.pairAssetA));
      if (!isThisPair) continue;
      // Search is cross-chain; honor the chain filter at the source when
      // provided (poolService.applyFilters also enforces it downstream).
      if (query.chain && pair.chainId !== query.chain) continue;

      const chain = canonicalChain(pair.chainId);
      pools.push({
        dex: pair.dexId ?? "unknown",
        chain,
        // AMM version from the labels ("v3" in ["v3", "0.3%"]); null otherwise.
        version: versionFromLabels(pair.labels),
        feeTier: feeTierFromLabels(pair.labels),
        tvl: toFiniteOrNull(pair.liquidity?.usd),
        volume: toFiniteOrNull(pair.volume?.h24),
        activeLiquidity: null, // not exposed by DexScreener -- see header
        // Pool contract address -- the future subgraph-enrichment join key.
        // Chain-aware validation nulls malformed (e.g. 64-hex v4) EVM addresses.
        address: validatePoolAddress(pair.pairAddress, chain),
        // Token contract addresses back ingestion's identity verification.
        baseTokenAddress: pair.baseToken?.address?.toLowerCase(),
        quoteTokenAddress: pair.quoteToken?.address?.toLowerCase(),
      });
      if (pools.length >= MAX_POOLS) break;
    }
    return pools;
  }

  private async search(q: string): Promise<DsPair[]> {
    const url = `${this.baseUrl}/latest/dex/search?q=${encodeURIComponent(q)}`;
    let body: DsSearchResponse;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new PoolSourceUnavailableError(`DexScreener request failed (${res.status})`);
      }
      body = (await res.json()) as DsSearchResponse;
    } catch (err) {
      if (err instanceof PoolSourceUnavailableError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new PoolSourceUnavailableError(`DexScreener unreachable: ${reason}`);
    }
    return body.pairs ?? [];
  }
}
