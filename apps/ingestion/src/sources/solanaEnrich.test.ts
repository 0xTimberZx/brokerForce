import { describe, it, expect } from "vitest";
import { orcaFeeRateToFractional } from "./orcaWhirlpools.js";
import { classifyRaydiumType, parseRaydiumPool } from "./raydiumClmm.js";

describe("orcaFeeRateToFractional", () => {
  it("converts Orca hundredths-of-bps (millionths) to fractional", () => {
    expect(orcaFeeRateToFractional(100)).toBe(0.0001); // 1 bp = 0.01%
    expect(orcaFeeRateToFractional(500)).toBe(0.0005); // 0.05%
    expect(orcaFeeRateToFractional(3000)).toBe(0.003); // 0.3%
    expect(orcaFeeRateToFractional(10000)).toBe(0.01); // 1%
  });

  it("accepts string rates (JSON may return strings)", () => {
    expect(orcaFeeRateToFractional("3000")).toBe(0.003);
  });

  it("returns null for 0 / negative / non-numeric -> fall back to fee_tier", () => {
    expect(orcaFeeRateToFractional(0)).toBeNull();
    expect(orcaFeeRateToFractional(-5)).toBeNull();
    expect(orcaFeeRateToFractional("oops")).toBeNull();
    expect(orcaFeeRateToFractional(null)).toBeNull();
    expect(orcaFeeRateToFractional(undefined)).toBeNull();
  });
});

describe("classifyRaydiumType", () => {
  it("maps Concentrated -> clmm and Standard -> standard (case-insensitive)", () => {
    expect(classifyRaydiumType("Concentrated")).toBe("clmm");
    expect(classifyRaydiumType("concentrated")).toBe("clmm");
    expect(classifyRaydiumType("Standard")).toBe("standard");
  });
  it("treats anything else / missing as 'other' (skipped)", () => {
    expect(classifyRaydiumType("AllConcentrated")).toBe("other");
    expect(classifyRaydiumType("")).toBe("other");
    expect(classifyRaydiumType(null)).toBe("other");
    expect(classifyRaydiumType(undefined)).toBe("other");
  });
});

describe("parseRaydiumPool", () => {
  it("reads the CLMM config tradeFeeRate (millionths) and marks it clmm", () => {
    const r = parseRaydiumPool({ type: "Concentrated", config: { tradeFeeRate: 2500 } });
    expect(r.poolKind).toBe("clmm");
    expect(r.feeTierFractional).toBe(0.0025); // 0.25%
  });

  it("accepts an already-fractional top-level feeRate (sub-1)", () => {
    const r = parseRaydiumPool({ type: "Standard", feeRate: 0.0025 });
    expect(r.poolKind).toBe("standard");
    expect(r.feeTierFractional).toBe(0.0025);
  });

  it("treats a >=1 feeRate as millionths", () => {
    expect(parseRaydiumPool({ type: "Concentrated", feeRate: 500 }).feeTierFractional).toBe(0.0005);
  });

  it("prefers the config tradeFeeRate over a top-level feeRate when both present", () => {
    const r = parseRaydiumPool({ type: "Concentrated", feeRate: 0.01, config: { tradeFeeRate: 100 } });
    expect(r.feeTierFractional).toBe(0.0001);
  });

  it("falls back to ammConfig.tradeFeeRate when config is absent", () => {
    expect(parseRaydiumPool({ type: "Concentrated", ammConfig: { tradeFeeRate: 3000 } }).feeTierFractional).toBe(0.003);
  });

  it("returns null fee for an entry with no usable rate", () => {
    const r = parseRaydiumPool({ type: "Concentrated", feeRate: 0 });
    expect(r.feeTierFractional).toBeNull();
  });

  it("handles a missing entry (api-v3 returns [null] for a miss)", () => {
    const r = parseRaydiumPool(null);
    expect(r.poolKind).toBe("other");
    expect(r.feeTierFractional).toBeNull();
  });
});
