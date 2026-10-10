// Time-series ORT score trend -- "momentum" (spec 020). Answers the question
// people usually mean by "trend": is this pair's score RISING or FALLING over
// recent days? Distinct from quadrant.ts's computeTrend, which compares the
// 30d vs 90d quadrant within a single run (regime position, not movement).
//
// Method: least-squares slope of score vs time over a trailing lookback, read
// from the ort_score_history series. Uneven spacing and gaps (the pipeline
// doesn't always run daily) are handled naturally by the regression -- no
// resampling needed. Classified with a documented deadband, in the spirit of
// score.ts's trendScore: simple and explainable over a "principled" curve.
//
// HONEST CAVEAT: the ORT score is RELATIVE (its components are percentile
// ranks against the current active-tier population, score.ts). A rising
// momentum therefore means "getting more attractive relative to peers" -- the
// pair's own metrics may have improved, or the field around it weakened. It is
// a useful signal; it is NOT an absolute-fundamentals trend. Copy must not
// overclaim.

export type ScoreTrend = "rising" | "falling" | "flat";

/** Trailing window the slope is fitted over -- "recent momentum". */
export const SCORE_TREND_LOOKBACK_DAYS = 14;
/** Projected change (score points over the lookback) below which movement is
 * noise, not a trend. 2.5 points over two weeks is the deadband. */
export const SCORE_TREND_EPSILON = 2.5;
/** Minimum evidence: fewer points than this -> null ("building"). */
export const SCORE_TREND_MIN_POINTS = 3;
/** The points must span at least this many days -> otherwise null. Guards
 * against calling a trend off a cluster of points all from one day. */
export const SCORE_TREND_MIN_SPAN_DAYS = 5;

const MS_PER_DAY = 86_400_000;

export interface ScoreTrendPoint {
  t: Date;
  score: number;
}

export interface ScoreTrendResult {
  trend: ScoreTrend | null;
  /** Projected change in score points over the lookback (slope x lookback).
   * null exactly when trend is null. */
  change: number | null;
}

/** PURE. `points` may be unsorted and may include points outside the lookback
 * (they're filtered); exact-duplicate timestamps are collapsed (last wins). */
export function computeScoreTrend(points: ScoreTrendPoint[], now: Date = new Date()): ScoreTrendResult {
  const nowMs = now.getTime();
  const cutoff = nowMs - SCORE_TREND_LOOKBACK_DAYS * MS_PER_DAY;

  // Keep in-window, finite points; collapse duplicate timestamps (last wins).
  const byTime = new Map<number, number>();
  for (const p of points) {
    const ms = p.t.getTime();
    if (!Number.isFinite(ms) || !Number.isFinite(p.score)) continue;
    if (ms < cutoff || ms > nowMs) continue;
    byTime.set(ms, p.score);
  }
  if (byTime.size < SCORE_TREND_MIN_POINTS) return { trend: null, change: null };

  const xs: number[] = []; // days relative to now (<= 0)
  const ys: number[] = [];
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const [ms, score] of byTime) {
    xs.push((ms - nowMs) / MS_PER_DAY);
    ys.push(score);
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if ((maxMs - minMs) / MS_PER_DAY < SCORE_TREND_MIN_SPAN_DAYS) return { trend: null, change: null };

  // Ordinary least squares: slope = cov(x,y) / var(x).
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    cov += dx * (ys[i]! - meanY);
    varX += dx * dx;
  }
  if (varX === 0) return { trend: null, change: null }; // degenerate; span guard makes this unreachable
  const slope = cov / varX; // points per day
  const change = slope * SCORE_TREND_LOOKBACK_DAYS;

  const trend: ScoreTrend = change >= SCORE_TREND_EPSILON ? "rising" : change <= -SCORE_TREND_EPSILON ? "falling" : "flat";
  return { trend, change };
}
