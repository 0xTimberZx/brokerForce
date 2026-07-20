import { describe, it, expect } from "vitest";
import { parseAltMeData, normalizeClassification } from "./sentiment.js";

describe("normalizeClassification", () => {
  it("keeps a recognized provider label verbatim", () => {
    expect(normalizeClassification("Extreme Greed", 82)).toBe("Extreme Greed");
    expect(normalizeClassification("Fear", 30)).toBe("Fear");
  });

  it("derives from value when the label is missing or unrecognized", () => {
    // Guards against a renamed/new upstream label silently corrupting a row.
    expect(normalizeClassification(undefined, 10)).toBe("Extreme Fear");
    expect(normalizeClassification("", 40)).toBe("Fear");
    expect(normalizeClassification("Weird New Label", 50)).toBe("Neutral");
    expect(normalizeClassification(undefined, 60)).toBe("Greed");
    expect(normalizeClassification(undefined, 90)).toBe("Extreme Greed");
  });
});

describe("parseAltMeData", () => {
  const sample = [
    { value: "82", value_classification: "Extreme Greed", timestamp: "1700006400" }, // 2023-11-15
    { value: "40", value_classification: "Fear", timestamp: "1699920000" }, // 2023-11-14
  ];

  it("maps entries to MarketSentiment rows, oldest-first", () => {
    const rows = parseAltMeData(sample, "alternative.me");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date < rows[1]!.date).toBe(true); // sorted ascending
    expect(rows[1]).toEqual({
      source: "alternative.me",
      date: "2023-11-15",
      value: 82,
      classification: "Extreme Greed",
    });
  });

  it("rounds the value and stamps the source", () => {
    const rows = parseAltMeData([{ value: "55", value_classification: "Greed", timestamp: "1699920000" }], "src");
    expect(rows[0]!.value).toBe(55);
    expect(rows[0]!.source).toBe("src");
  });

  it("drops unparseable rows rather than writing garbage", () => {
    const rows = parseAltMeData(
      [
        { value: "not-a-number", value_classification: "Fear", timestamp: "1699920000" },
        { value: "150", value_classification: "Greed", timestamp: "1699920000" }, // out of 0-100
        { value: "50", value_classification: "Neutral", timestamp: "nope" },
        { value: "50", value_classification: "Neutral", timestamp: "1699920000" }, // the one valid row
      ],
      "src"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(50);
  });
});
