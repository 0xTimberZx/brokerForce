import { describe, it, expect } from "vitest";
import {
  computeScoreTrend,
  SCORE_TREND_EPSILON,
  SCORE_TREND_LOOKBACK_DAYS,
  type ScoreTrendPoint,
} from "./score-trend.js";

const NOW = new Date("2026-10-09T12:00:00Z");
const DAY = 86_400_000;
/** A point `daysAgo` days before NOW with the given score. */
const pt = (daysAgo: number, score: number): ScoreTrendPoint => ({ t: new Date(NOW.getTime() - daysAgo * DAY), score });

describe("computeScoreTrend (spec 020)", () => {
  it("reads a steadily climbing series as rising, with a positive projected change", () => {
    // +1 point/day over 10 days -> slope 1/day -> change +14 over the 14d lookback
    const r = computeScoreTrend([pt(10, 70), pt(8, 72), pt(6, 74), pt(4, 76), pt(2, 78), pt(0, 80)], NOW);
    expect(r.trend).toBe("rising");
    expect(r.change).toBeCloseTo(SCORE_TREND_LOOKBACK_DAYS, 6);
  });

  it("reads a decaying series as falling", () => {
    const r = computeScoreTrend([pt(12, 60), pt(9, 57), pt(6, 54), pt(3, 51), pt(0, 48)], NOW);
    expect(r.trend).toBe("falling");
    expect(r.change).toBeLessThan(-SCORE_TREND_EPSILON);
  });

  it("reads a stable blue-chip as flat (small wobble inside the deadband)", () => {
    const r = computeScoreTrend([pt(13, 85.6), pt(10, 85.9), pt(7, 85.4), pt(4, 85.8), pt(1, 85.5)], NOW);
    expect(r.trend).toBe("flat");
    expect(Math.abs(r.change!)).toBeLessThan(SCORE_TREND_EPSILON);
  });

  it("a real move below the deadband is still flat -- 2.5 points over 14d is the bar", () => {
    // +1 point total over 10 days -> change ~ +1.4, under 2.5
    const r = computeScoreTrend([pt(10, 70), pt(5, 70.5), pt(0, 71)], NOW);
    expect(r.trend).toBe("flat");
  });

  it("returns null (building) with fewer than 3 points", () => {
    expect(computeScoreTrend([pt(10, 70), pt(0, 80)], NOW)).toEqual({ trend: null, change: null });
    expect(computeScoreTrend([], NOW)).toEqual({ trend: null, change: null });
  });

  it("returns null when the points don't span at least 5 days -- no trend off one day's cluster", () => {
    const r = computeScoreTrend([pt(1, 70), pt(0.5, 75), pt(0, 80)], NOW);
    expect(r.trend).toBeNull();
    expect(r.change).toBeNull();
  });

  it("ignores points older than the lookback -- a huge old value can't drive the trend", () => {
    // Stale point 40d ago at 20; the in-window series is flat at 80.
    const r = computeScoreTrend([pt(40, 20), pt(12, 80), pt(8, 80), pt(4, 80), pt(0, 80)], NOW);
    expect(r.trend).toBe("flat");
  });

  it("handles irregular spacing and a gap in the middle (the real pipeline cadence)", () => {
    // Daily for 3 days, then a 7-day gap, then two more points -- still rising.
    const r = computeScoreTrend([pt(13, 60), pt(12, 61), pt(11, 62), pt(3, 70), pt(0, 73)], NOW);
    expect(r.trend).toBe("rising");
  });

  it("collapses duplicate timestamps (last wins) rather than double-weighting them", () => {
    const t = pt(7, 70);
    const dup = { t: t.t, score: 90 };
    const r = computeScoreTrend([pt(14, 70), t, dup, pt(0, 70)], NOW);
    // Three distinct timestamps; the day-7 value is 90 (last), giving a
    // symmetric hump -> no net slope -> flat.
    expect(r.trend).toBe("flat");
  });

  it("is order-independent", () => {
    const sorted = [pt(10, 70), pt(5, 75), pt(0, 80)];
    const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];
    expect(computeScoreTrend(shuffled, NOW)).toEqual(computeScoreTrend(sorted, NOW));
  });
});
