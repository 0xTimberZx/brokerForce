import { describe, it, expect } from "vitest";
import { loginPath, safeNext, startParamFor } from "./session";

describe("safeNext", () => {
  it("keeps paths on this site, query included", () => {
    expect(safeNext("/pairs/ETH/XRP")).toBe("/pairs/ETH/XRP");
    expect(safeNext("/ranks?w=30&pair=CRO-SOL&asOf=2026-11-06")).toBe("/ranks?w=30&pair=CRO-SOL&asOf=2026-11-06");
  });

  it("never sends anyone off-site", () => {
    for (const bad of ["https://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "evil", ""]) {
      expect(safeNext(bad)).toBe("/");
    }
    expect(safeNext(null)).toBe("/");
  });

  it("doesn't loop back to /login", () => {
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/login?next=/x")).toBe("/");
  });
});

describe("loginPath", () => {
  it("carries the deep link through", () => {
    expect(loginPath("/pairs/ETH/XRP?window=30")).toBe("/login?next=%2Fpairs%2FETH%2FXRP%3Fwindow%3D30");
    expect(loginPath("/")).toBe("/login");
  });
});

describe("startParamFor", () => {
  it("matches the API's encoding (base64url of the path)", () => {
    expect(startParamFor("/pairs/ETH/XRP")).toBe(`l_${Buffer.from("/pairs/ETH/XRP").toString("base64url")}`);
    expect(startParamFor("/")).toBe("login");
    expect(startParamFor("//evil.example")).toBe("login");
    expect(startParamFor("/" + "a".repeat(80))).toBe("login");
  });
});
