import { describe, it, expect } from "vitest";
import { DEFAULT_VIEW, readView, shortDate, writeView } from "./urlState";

describe("ranks URL state", () => {
  it("reads the spec's example link", () => {
    const v = readView(new URLSearchParams("w=30&pair=CRO-SOL&range=90&asOf=2026-11-06&avg=1&ext=1&price=1"));
    expect(v).toEqual({ w: 30, pair: "CRO-SOL", range: "90", asOf: "2026-11-06", avg: true, ext: true, price: true });
  });

  it("round-trips through writeView", () => {
    const v = { ...DEFAULT_VIEW, w: 200 as const, pair: "ETH-XRP", range: "all" as const, asOf: "2026-10-01", ext: false };
    expect(readView(writeView(v))).toEqual(v);
  });

  it("falls back to defaults for bad values", () => {
    expect(readView(new URLSearchParams("w=7&pair=<script>&range=5&asOf=2026-13-40&avg=maybe"))).toEqual(DEFAULT_VIEW);
    expect(readView(new URLSearchParams("pair=eth-xrp")).pair).toBe("ETH-XRP");
  });

  it("formats run dates for the banner", () => {
    expect(shortDate("2026-11-06")).toBe("Nov 6");
  });
});
