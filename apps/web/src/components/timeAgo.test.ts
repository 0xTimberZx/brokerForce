import { describe, it, expect } from "vitest";
import { timeAgo } from "./timeAgo";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe("timeAgo", () => {
  it("counts up in minutes, hours and days", () => {
    expect(timeAgo(ago(20_000), NOW)).toBe("just now");
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(timeAgo(ago(3 * 3_600_000 + 59 * 60_000), NOW)).toBe("3h ago");
    expect(timeAgo(ago(2 * 86_400_000), NOW)).toBe("2d ago");
  });

  it("switches to a date after a week", () => {
    expect(timeAgo("2026-11-12T08:00:00Z", NOW)).toBe("Nov 12");
  });

  it("is blank for a missing or broken time, and never negative", () => {
    expect(timeAgo(undefined, NOW)).toBe("");
    expect(timeAgo("not a date", NOW)).toBe("");
    expect(timeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });
});
