// Shared pool data sources -- the PoolSource seam plus its real
// implementations. Extracted from apps/api/src/services once apps/ingestion
// became the second consumer (the pool-ingestion job polls the same sources
// the API live-fetches from), following the same extract-on-second-use
// precedent as packages/stats.

export type { PoolQuery, RawPoolData, PoolSource } from "./poolSource.js";
export {
  UnimplementedPoolSource,
  PoolSourceNotImplementedError,
  PoolSourceUnavailableError,
} from "./poolSource.js";
export { GeckoTerminalPoolSource, parsePoolName, symbolsMatch } from "./geckoTerminalPoolSource.js";
export { DexScreenerPoolSource, feeTierFromLabels } from "./dexScreenerPoolSource.js";
export { FallbackPoolSource } from "./fallbackPoolSource.js";

import type { PoolSource } from "./poolSource.js";
import { GeckoTerminalPoolSource } from "./geckoTerminalPoolSource.js";
import { DexScreenerPoolSource } from "./dexScreenerPoolSource.js";
import { FallbackPoolSource } from "./fallbackPoolSource.js";

/** The standard production source chain: DexScreener first (300 req/min --
 * survives GitHub Actions' shared, rate-limit-saturated egress IPs, where
 * GeckoTerminal's ~30/min public limit is typically already exhausted),
 * GeckoTerminal second. */
export function defaultPoolSource(): PoolSource {
  return new FallbackPoolSource([new DexScreenerPoolSource(), new GeckoTerminalPoolSource()]);
}
