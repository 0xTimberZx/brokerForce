# 014 — Thin-Liquidity Flag on the Rankings

> **Status: Approved-to-build 2026-08-02.** Small, additive honesty flag on the
> Top Opportunities board.

## Purpose / the finding
BTC/XRP scores **85 (prime)** with an ORT **liquidity component of 0.86**, yet
its deepest on-chain pool is **~$1,071 TVL** — basically un-LP-able. The reason:
ORT's volume/liquidity components are derived from **asset-level trading volume**
(~$945M/day for the pair), **not pool depth**. So a pair can rank "prime" while
having no real concentrated-liquidity venue to provide into. (BTC/XRP also has
no Uniswap-v3 pool at all — its pools are tiny v2 / XRPL-native / unversioned —
which is why fee enrichment can't touch it either.)

This is misleading for the LP use case BrokerForce is about. The fix isn't to
change the ORT score (its price-relationship read is genuine); it's to **surface
the pair's real deepest-pool depth and flag when it's below a usable floor**, so
a high score can't imply an actionable pool that isn't there.

## Scope (additive, read-side only)
- **`OrtRankedPair`** gains `topPoolTvl: number | null` (the pair's deepest
  single pool's TVL) and `thinLiquidity: boolean`.
- **`routes/ort.ts`** ranked query: join `MAX(tvl)` over the pair's pools;
  `thinLiquidity = topPoolTvl == null || topPoolTvl < MIN_ACTIONABLE_POOL_TVL_USD`.
  Floor = **$50,000**, mirroring the active-tier gate's per-pool bar
  (`ACTIVE_TVL_THRESHOLD_USD`) — the platform's own "this pool matters" line.
  Tunable via the named constant.
- **`TopOpportunitiesPanel.tsx`**: when `thinLiquidity`, render a small muted
  **"thin liq"** tag next to the signal, so the row reads honestly. A one-line
  key note explains it (score reflects the price relationship, not pool depth).

Deliberately NOT changing: the ORT score/weights, the pair-detail page, or any
DB schema (the depth is read live from `pools`). Deeper work — folding real pool
depth into the score itself — is a later, larger question.

## Acceptance criteria
- [ ] `/pairs/ort` returns `topPoolTvl` + `thinLiquidity` per ranked pair;
      `thinLiquidity` true for a pair whose deepest pool < $50k or has no pools.
- [ ] Top Opportunities board shows the "thin liq" tag on those rows only.
- [ ] typecheck / lint / build / suite pass.

## Verification
Scratch DB: seed a prime-scoring pair with only a $1k pool and another with a
$5M pool; assert the ranked response flags the first `thinLiquidity: true` and
the second `false`; screenshot the board showing the tag.
