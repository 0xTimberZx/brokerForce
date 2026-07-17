import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeckoTerminalPoolSource, parsePoolName, symbolsMatch } from "./geckoTerminalPoolSource.js";
import { PoolSourceUnavailableError } from "./poolSource.js";

function gtPool(
  name: string,
  overrides: {
    reserve?: string | null;
    volumeH24?: string | null;
    dex?: string | null;
    network?: string | null;
  } = {}
) {
  return {
    id: `net_0xabc`,
    attributes: {
      name,
      reserve_in_usd: overrides.reserve === undefined ? "1000000" : overrides.reserve,
      volume_usd: { h24: overrides.volumeH24 === undefined ? "50000" : overrides.volumeH24 },
    },
    relationships: {
      dex: { data: overrides.dex === null ? null : { id: overrides.dex ?? "uniswap_v3" } },
      network: { data: overrides.network === null ? null : { id: overrides.network ?? "eth" } },
    },
  };
}

function mockFetchResponse(data: unknown[], ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ data }),
  });
}

describe("parsePoolName", () => {
  it("extracts symbols and fee tier from a v3-style name", () => {
    expect(parsePoolName("WETH / USDC 0.05%")).toEqual({ symbols: ["WETH", "USDC"], feeTier: 0.0005 });
  });

  it("returns feeTier 0 (unknown) when the name has no fee", () => {
    expect(parsePoolName("WETH / USDC")).toEqual({ symbols: ["WETH", "USDC"], feeTier: 0 });
  });

  it("handles whole-number fees", () => {
    expect(parsePoolName("PEPE / WETH 1%")).toEqual({ symbols: ["PEPE", "WETH"], feeTier: 0.01 });
  });
});

describe("symbolsMatch", () => {
  it("matches exact symbols case-insensitively", () => {
    expect(symbolsMatch("usdc", "USDC")).toBe(true);
  });

  it("treats the canonical wrapped form as the same asset, both directions", () => {
    expect(symbolsMatch("WETH", "ETH")).toBe(true);
    expect(symbolsMatch("BTC", "WBTC")).toBe(true);
  });

  it("treats BNB Chain's BTCB (Binance-Peg BTC) as a form of BTC", () => {
    // BTCB doesn't follow the W-prefix pattern, so it needs the explicit alias.
    expect(symbolsMatch("BTCB", "BTC")).toBe(true);
    expect(symbolsMatch("btcb", "btc")).toBe(true);
    expect(symbolsMatch("BTC", "BTCB")).toBe(true);
  });

  it("does not match different assets", () => {
    expect(symbolsMatch("USDT", "USDC")).toBe(false);
    // BTCB is BTC's form only -- it must not match some other asset.
    expect(symbolsMatch("BTCB", "BCH")).toBe(false);
  });
});

describe("GeckoTerminalPoolSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a matching pool onto RawPoolData", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([gtPool("WETH / USDC 0.3%")]));
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools).toEqual([
      {
        dex: "uniswap_v3",
        chain: "eth",
        feeTier: 0.003,
        tvl: 1_000_000,
        volume: 50_000,
        activeLiquidity: null,
      },
    ]);
  });

  it("filters out fuzzy search hits that are not this pair", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchResponse([
        gtPool("WETH / USDC 0.05%"),
        gtPool("WETH / USDT 0.05%"), // surfaced by fuzzy search, wrong quote asset
        gtPool("USDC / WETH 1%"), // reversed order still counts
      ])
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools.map((p) => p.feeTier)).toEqual([0.0005, 0.01]);
  });

  it("passes the chain filter through as GeckoTerminal's network param", async () => {
    const fetchMock = mockFetchResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const source = new GeckoTerminalPoolSource();
    await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC", chain: "arbitrum" });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("network=arbitrum");
  });

  it("survives items with missing relationships (live API omits them sometimes)", async () => {
    // Regression: the first automated ingestion run crashed with
    // "Cannot read properties of undefined (reading 'data')" on a real
    // search response whose item had no relationships.dex object.
    const bare = {
      id: "eth_0xbare",
      attributes: { name: "WETH / USDC 0.3%", reserve_in_usd: "500000", volume_usd: { h24: "10000" } },
      // no relationships at all
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [bare] }) })
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools).toEqual([
      { dex: "unknown", chain: "unknown", feeTier: 0.003, tvl: 500_000, volume: 10_000, activeLiquidity: null },
    ]);
  });

  it("requests dex and network relationships via the include param", async () => {
    const fetchMock = mockFetchResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const source = new GeckoTerminalPoolSource();
    await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("include=dex%2Cnetwork");
  });

  it("returns null tvl/volume rather than NaN for missing numbers", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([gtPool("WETH / USDC 0.3%", { reserve: null, volumeH24: "" })]));
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.tvl).toBeNull();
    expect(pools[0]?.volume).toBeNull();
  });

  it("throws PoolSourceUnavailableError on a non-OK response", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([], false, 429));
    const source = new GeckoTerminalPoolSource();
    await expect(source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).rejects.toThrow(
      PoolSourceUnavailableError
    );
  });

  it("wraps network-level fetch failures in PoolSourceUnavailableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const source = new GeckoTerminalPoolSource();
    await expect(source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).rejects.toThrow(
      /GeckoTerminal unreachable/
    );
  });
});
