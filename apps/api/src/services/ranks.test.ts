import { describe, it, expect } from "vitest";
import { fetchFrom, fitTrend, parseRanksParams, rangeStart, rollingAverage } from "./ranks.js";

describe("parseRanksParams", () => {
  it("reads valid URL state", () => {
    expect(parseRanksParams({ w: "200", asOf: "2026-11-06", pair: "cro-sol", range: "all" })).toEqual({
      window: 200,
      asOf: "2026-11-06",
      pair: ["CRO", "SOL"],
      range: "all",
    });
    expect(parseRanksParams({ window: "90", pair: "ETH/XRP", range: "30" }).pair).toEqual(["ETH", "XRP"]);
  });

  it("falls back to defaults for anything else, never passing text through", () => {
    expect(parseRanksParams({ w: "45", asOf: "2026-02-30", pair: "ETH-XRP'; drop table pairs;--", range: "7" })).toEqual({
      window: 30,
      asOf: null,
      pair: null,
      range: 90,
    });
    expect(parseRanksParams({ asOf: "yesterday" }).asOf).toBeNull();
  });
});

const pts = (ranks: number[], start = "2026-11-01") =>
  ranks.map((rank, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), rank };
  });

describe("rollingAverage", () => {
  it("averages the trailing 7 points once 3 exist", () => {
    expect(rollingAverage(pts([4, 2, 3, 5, 1, 1, 5, 9]))).toEqual([null, null, 3, 3.5, 3, 2.7, 3, 3.7]);
  });
});

describe("fitTrend", () => {
  it("fits a straight climb and extends it 7 days, clamped to rank 1", () => {
    const fit = fitTrend(pts([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].slice(0, 10)), 100)!;
    expect(fit.slope).toBe(-1);
    expect(fit.points.filter((p) => p.phase === "fit")).toHaveLength(10);
    const ext = fit.points.filter((p) => p.phase === "extension");
    expect(ext).toHaveLength(7);
    expect(ext[0]).toEqual({ date: "2026-11-11", rank: 4, phase: "extension" });
    expect(ext[6]!.rank).toBe(1); // clamped, never above #1
  });

  it("uses only the last 14 days and needs at least 5 points", () => {
    const fit = fitTrend(pts([...Array(20).fill(50), 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), 100)!;
    expect(fit.slope).toBe(0);
    expect(fit.points[0]!.rank).toBe(10);
    expect(fitTrend(pts([1, 2, 3, 4]), 100)).toBeNull();
    expect(fitTrend([], 100)).toBeNull();
  });
});

describe("date windows", () => {
  it("fetches 7 extra lead-in days and shows exactly the range", () => {
    expect(fetchFrom("2026-11-06", 30)).toBe("2026-09-30");
    expect(rangeStart("2026-11-06", 30)).toBe("2026-10-08");
    expect(fetchFrom("2026-11-06", "all")).toBeNull();
  });
});
