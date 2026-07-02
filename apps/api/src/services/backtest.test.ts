import { describe, it, expect } from "vitest";
import { runBacktest, widthPctToRange, DEFAULT_POSITION_SIZE_USD } from "./backtest.js";

function makeInput(overrides: Partial<Parameters<typeof runBacktest>[0]> = {}) {
  return {
    pricesA: [100, 100, 100, 100, 100],
    pricesB: [50, 50, 50, 50, 50],
    volumesA: [1000, 1000, 1000, 1000, 1000],
    volumesB: [800, 800, 800, 800, 800],
    dates: ["d1", "d2", "d3", "d4", "d5"],
    rangeMin: 1.8,
    rangeMax: 2.2,
    feeTier: 0.003,
    ...overrides,
  };
}

describe("runBacktest", () => {
  it("reports 100% time in range and zero exits when the price ratio never leaves the range", () => {
    const result = runBacktest(makeInput());
    expect(result.timeInRangePct).toBe(1);
    expect(result.exitCount).toBe(0);
    expect(result.exitTimeline).toEqual([]);
  });

  it("reports zero IL when the price ratio doesn't move", () => {
    const result = runBacktest(makeInput());
    expect(result.ilEstimate).toBeCloseTo(0, 10);
  });

  it("earns zero fees when the ratio is out of range the entire time", () => {
    const result = runBacktest(makeInput({ rangeMin: 5, rangeMax: 6 })); // ratio is always 2, never in [5,6]
    expect(result.feesEarnedUsd).toBe(0);
    expect(result.timeInRangePct).toBe(0);
  });

  it("counts an exit and a re-entry event when leaving and returning to range", () => {
    // ratio: 2.0, 2.0, 3.0 (out), 2.0, 2.0 (back in) -- range is [1.8, 2.2]
    const result = runBacktest(
      makeInput({
        pricesA: [100, 100, 150, 100, 100],
        rangeMin: 1.8,
        rangeMax: 2.2,
      })
    );
    expect(result.exitCount).toBe(1);
    expect(result.exitTimeline).toEqual([
      { date: "d3", type: "exit" },
      { date: "d4", type: "re-entry" },
    ]);
    expect(result.timeInRangePct).toBeCloseTo(4 / 5, 6);
  });

  it("defaults positionSizeUsd to DEFAULT_POSITION_SIZE_USD when not supplied", () => {
    const result = runBacktest(makeInput());
    expect(result.positionSizeUsd).toBe(DEFAULT_POSITION_SIZE_USD);
  });

  it("respects an explicit positionSizeUsd override", () => {
    const result = runBacktest(makeInput({ positionSizeUsd: 50_000 }));
    expect(result.positionSizeUsd).toBe(50_000);
  });

  it("a tighter range earns more in fees than a wider range, all else equal", () => {
    const tight = runBacktest(makeInput({ rangeMin: 1.95, rangeMax: 2.05 })); // narrow band, ratio=2 stays in
    const wide = runBacktest(makeInput({ rangeMin: 1.0, rangeMax: 3.0 })); // wide band, ratio=2 also stays in
    // Both are 100% in range, so the only difference is the concentration
    // factor -- this directly tests the "narrower range = more assumed pool
    // share = more fees" property the service is designed around.
    expect(tight.timeInRangePct).toBe(1);
    expect(wide.timeInRangePct).toBe(1);
    expect(tight.feesEarnedUsd).toBeGreaterThan(wide.feesEarnedUsd);
  });

  it("throws if input arrays have mismatched lengths", () => {
    expect(() => runBacktest(makeInput({ pricesA: [100, 100] }))).toThrow();
  });

  it("net P&L is the sum of fees earned and IL in dollar terms", () => {
    const result = runBacktest(
      makeInput({
        pricesA: [100, 200], // ratio doubles -- triggers real, nonzero IL
        pricesB: [50, 50],
        volumesA: [1000, 1000],
        volumesB: [800, 800],
        dates: ["d1", "d2"],
        rangeMin: 1.0,
        rangeMax: 5.0, // wide enough to stay in range the whole time, isolating the IL effect
      })
    );
    const expectedIlUsd = result.ilEstimate * result.positionSizeUsd;
    expect(result.netPnlUsd).toBeCloseTo(result.feesEarnedUsd + expectedIlUsd, 6);
  });
});

describe("widthPctToRange", () => {
  it("translates a %-width input into symmetric min/max bounds around the entry ratio", () => {
    const { rangeMin, rangeMax } = widthPctToRange(2.0, 0.1); // +/-10% around ratio=2.0
    expect(rangeMin).toBeCloseTo(1.9, 6);
    expect(rangeMax).toBeCloseTo(2.1, 6);
  });
});
