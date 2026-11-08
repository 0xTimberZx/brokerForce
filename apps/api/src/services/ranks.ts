// Spec 022, Phase 2: pure helpers for the /ranks view -- parsing the URL-state
// parameters, the 7-day rank average and the 14-day trend fit. Kept apart from
// the route so they can be unit-tested without a database.
import type { CanonicalWindow } from "@brokerforce/types";

export type RanksRange = 30 | 90 | "all";

export interface RanksParams {
  window: CanonicalWindow;
  /** Run date, YYYY-MM-DD. Null means the latest run. */
  asOf: string | null;
  /** Searched pair as [base, quote], uppercase. */
  pair: [string, string] | null;
  range: RanksRange;
}

/** Every value is checked against its allowed set; anything else falls back
 * to the default. Nothing here ever reaches SQL as text. */
export function parseRanksParams(q: Record<string, unknown>): RanksParams {
  const w = Number(q.window ?? q.w);
  const window: CanonicalWindow = w === 90 || w === 200 ? w : 30;

  let asOf: string | null = null;
  const rawAsOf = String(q.asOf ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawAsOf)) {
    const d = new Date(`${rawAsOf}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === rawAsOf) asOf = rawAsOf;
  }

  let pair: [string, string] | null = null;
  const m = /^([A-Za-z0-9]{2,10})[-/]([A-Za-z0-9]{2,10})$/.exec(String(q.pair ?? ""));
  if (m) pair = [m[1]!.toUpperCase(), m[2]!.toUpperCase()];

  const r = String(q.range ?? "");
  const range: RanksRange = r === "30" ? 30 : r === "all" ? "all" : 90;

  return { window, asOf, pair, range };
}

export interface RankPoint {
  date: string; // YYYY-MM-DD
  rank: number;
}

/** Trailing 7-point average of rank, rounded to 0.1 (null until 3 points). */
export function rollingAverage(points: RankPoint[], span = 7): (number | null)[] {
  return points.map((_, i) => {
    const slice = points.slice(Math.max(0, i - span + 1), i + 1);
    if (slice.length < 3) return null;
    return Math.round((slice.reduce((s, p) => s + p.rank, 0) / slice.length) * 10) / 10;
  });
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayIndex(date: string, origin: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${origin}T00:00:00Z`)) / 86_400_000);
}

export interface TrendPoint {
  date: string;
  rank: number;
  phase: "fit" | "extension";
}

export interface TrendFit {
  /** Rank change per day (negative = climbing toward #1). */
  slope: number;
  points: TrendPoint[];
}

/**
 * Least-squares line through the last 14 days of rank, plus a 7-day
 * extension. Ranks are clamped to [1, maxRank]. Fewer than 5 points in the
 * window: no fit. Descriptive only -- it extends the recent line, it isn't a
 * forecast (Product_Principles.md §5).
 */
export function fitTrend(points: RankPoint[], maxRank: number, fitDays = 14, extendDays = 7): TrendFit | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1]!.date;
  const from = addDays(last, -(fitDays - 1));
  const recent = points.filter((p) => p.date >= from);
  if (recent.length < 5) return null;

  const xs = recent.map((p) => dayIndex(p.date, from));
  const ys = recent.map((p) => p.rank);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const at = (x: number) => Math.min(maxRank, Math.max(1, Math.round((my + slope * (x - mx)) * 10) / 10));

  const out: TrendPoint[] = recent.map((p, i) => ({ date: p.date, rank: at(xs[i]!), phase: "fit" }));
  const lastX = dayIndex(last, from);
  for (let k = 1; k <= extendDays; k++) {
    out.push({ date: addDays(last, k), rank: at(lastX + k), phase: "extension" });
  }
  return { slope: Math.round(slope * 100) / 100, points: out };
}

/** First date to fetch: the shown range plus 7 days of lead-in for the average. */
export function fetchFrom(asOf: string, range: RanksRange): string | null {
  return range === "all" ? null : addDays(asOf, -(range + 7));
}

export function rangeStart(asOf: string, range: RanksRange): string | null {
  return range === "all" ? null : addDays(asOf, -(range - 1));
}
