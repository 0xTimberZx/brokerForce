// Thin fetch wrapper for the API (docs/API.md). Real error handling here
// matters more than usual since 003's page needs to distinguish three
// genuinely different states for a pair: doesn't exist (404), exists but
// has no computed metrics yet (200 with metrics: null), and a real network
// failure -- conflating any two of these would mislead the person using the
// page about what's actually true.

import type { PairDetailResponse, PairHistoryResponse, CanonicalWindow, OrtScore, PoolListResponse, PoolWithDerived, PoolHistoryPoint } from "@brokerforce/types";

// Defaults to the Vite dev proxy (vite.config.ts rewrites /api/* to apps/api
// with no CORS needed, since the browser only ever talks to the Vite dev
// server itself). VITE_API_URL is the real production override, for when
// the API is actually deployed somewhere that isn't this dev proxy --
// apps/api has no CORS middleware installed, so calling an absolute
// cross-origin URL directly from here (the previous version of this file
// did exactly that) would fail in any real browser during local dev.
const API_URL = import.meta.env.VITE_API_URL ?? "/api";

export class PairNotFoundError extends Error {
  constructor(assetA: string, assetB: string) {
    super(`No pair found for ${assetA}/${assetB}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (res.status === 404) {
    throw new PairNotFoundError("", ""); // caller has the symbols already; see fetchPairDetail
  }
  if (!res.ok) {
    throw new Error(`API request failed (${res.status}): ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchPairDetail(
  assetA: string,
  assetB: string,
  window: CanonicalWindow
): Promise<PairDetailResponse> {
  try {
    return await getJson<PairDetailResponse>(`/pairs/${assetA}/${assetB}?window=${window}`);
  } catch (err) {
    if (err instanceof PairNotFoundError) throw new PairNotFoundError(assetA, assetB);
    throw err;
  }
}

export async function fetchPairHistory(
  assetA: string,
  assetB: string,
  window: CanonicalWindow
): Promise<PairHistoryResponse> {
  return getJson<PairHistoryResponse>(`/pairs/${assetA}/${assetB}/history?window=${window}`);
}

/**
 * 004 ORT Engine now exists, but most pairs still won't have a score --
 * only active-tier pairs do (ORT.md §5), and no pair can be promoted to
 * active yet without real pool data (apps/pair-engine/README.md). A missing
 * score is the common case, not an error -- returns null on a 404 (no score
 * for this pair/window) or any other failure, so the page renders an honest
 * "not available" state either way, without needing to distinguish "004
 * doesn't exist" from "this pair just doesn't have a score yet." Both look
 * the same to a caller and should render the same way.
 */
export async function fetchOrtScoreSafe(pairId: string, window: CanonicalWindow): Promise<OrtScore | null> {
  try {
    const res = await fetch(`${API_URL}/pairs/${pairId}/ort?window=${window}`);
    if (!res.ok) return null;
    return (await res.json()) as OrtScore;
  } catch {
    return null;
  }
}

export async function fetchPoolsForPair(
  assetA: string,
  assetB: string,
  filters: { chain?: string; dex?: string; feeTier?: string; minTvl?: string } = {}
): Promise<{ data: PoolListResponse; status: "ok" } | { status: "error"; reason: string } | { status: "unavailable" }> {
  const params = new URLSearchParams();
  if (filters.chain) params.set("chain", filters.chain);
  if (filters.dex) params.set("dex", filters.dex);
  if (filters.feeTier) params.set("feeTier", filters.feeTier);
  if (filters.minTvl) params.set("minTvl", filters.minTvl);
  const qs = params.toString();
  try {
    const res = await fetch(`${API_URL}/pairs/${assetA}/${assetB}/pools${qs ? `?${qs}` : ""}`);
    if (res.status === 503) return { status: "unavailable" };
    if (!res.ok) return { status: "error", reason: `HTTP ${res.status}` };
    return { data: await res.json() as PoolListResponse, status: "ok" };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : "unknown" };
  }
}

export async function fetchPoolDetail(poolId: string): Promise<PoolWithDerived | null> {
  try {
    const res = await fetch(`${API_URL}/pools/${poolId}`);
    if (!res.ok) return null;
    return await res.json() as PoolWithDerived;
  } catch {
    return null;
  }
}

export async function fetchPoolHistory(poolId: string): Promise<PoolHistoryPoint[]> {
  try {
    const res = await fetch(`${API_URL}/pools/${poolId}/history`);
    if (!res.ok) return [];
    return await res.json() as PoolHistoryPoint[];
  } catch {
    return [];
  }
}
