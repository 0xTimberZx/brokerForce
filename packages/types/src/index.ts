// Shared types across apps/web and apps/api.
// These mirror docs/Database.md's schema — if a field changes there, change it here too,
// not independently in each app.

export type AssetClass = "blue-chip" | "stable" | "growth-exotic" | "degen";

// Per docs/ORT.md §3 — the three canonical windows ORT (and pair_metrics) are computed on.
// Not user-selectable for the canonical ORT number; see docs/Architecture.md §5.
export type CanonicalWindow = 30 | 90 | 200;

// Per docs/ORT.md §6. Names are a first pass, not finalized — see docs/Glossary.md.
export type QuadrantLabel = "prime" | "active" | "quiet" | "avoid";

export type TrendDirection = "toward-prime" | "away-from-prime" | "flat";

// Per docs/Architecture.md's Pair Engine tiering decision + docs/ORT.md §5.
export type PairTier = "active" | "limited" | "excluded-stable";

export interface Asset {
  symbol: string;
  class: AssetClass;
  marketCap: number;
  circulatingSupply: number;
  fullyDilutedValue: number;
}

export interface AssetCandle {
  assetSymbol: string;
  timestamp: string; // ISO timestamp, hourly granularity per docs/Database.md §2 (proposed)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Pair {
  id: string;
  assetA: string;
  assetB: string;
  tier: PairTier;
  createdAt: string;
}

// Per docs/Analytics.md §2 — one row per pair, per canonical window.
export interface PairMetrics {
  pairId: string;
  window: CanonicalWindow;
  correlation: number;
  beta: number;
  cointegrationScore: number;
  historicalVolatility: number;
  relativeStrength: number;
  rangeStability: {
    pct2: number;
    pct5: number;
    pct10: number;
    pct15: number;
  };
  avgTimeInRangeDays: number;
  estimatedRebalancesPerYear: number;
  ilEstimate: number;
  feeOpportunity: number;
  volume: VolumeFieldSet;
  confidence: "full" | "low";
  computedAt: string;
}

// Per docs/Architecture.md §4 — first-class Pair Engine input, not just display data.
export interface VolumeFieldSet {
  avgVolume24h: number;
  avgVolume7d: number;
  avgVolume30d: number;
  volumeTvlRatio: number;
  volumeTrend: number;
  volumeStability: number;
  volumeShare: number;
  feeOpportunityScore: number;
}

// Per docs/ORT.md — the composite score, kept separate from PairMetrics since it's
// a derived value refreshed on its own cadence (docs/ORT.md §4).
export interface OrtScore {
  pairId: string;
  window: CanonicalWindow;
  score: number; // normalized 0–100
  quadrantLabel: QuadrantLabel;
  trendDirection: TrendDirection;
  confidence: "full" | "low";
  computedAt: string;
}

export interface Pool {
  id: string;
  pairId: string;
  dex: string;
  chain: string;
  feeTier: number;
  tvl: number;
  volume: number;
  activeLiquidity: number;
}

export interface PoolHistoryPoint {
  poolId: string;
  timestamp: string;
  tvl: number;
  volume: number;
}

// Per docs/specs/006-backtester/spec.md.
export interface BacktestRequest {
  pairId: string;
  rangeMin: number;
  rangeMax: number;
  periodStart: string;
  periodEnd: string;
  feeTier?: number;
  poolId?: string;
}

export interface BacktestResult {
  id: string;
  pairId: string;
  rangeMin: number;
  rangeMax: number;
  periodStart: string;
  periodEnd: string;
  feeTier: number;
  feesEarned: number;
  ilEstimate: number;
  netPnl: number;
  timeInRangePct: number;
  exitCount: number;
  createdAt: string;
}
