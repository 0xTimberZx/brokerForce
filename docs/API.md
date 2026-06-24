# API

## 1. Conventions

REST over HTTPS, JSON request/response bodies. No authentication currently required (per `Architecture.md` §5 — local-storage-only auth phase); this section gets revisited once wallet-based auth lands. All endpoints below were already referenced across the specs as dependencies — this document is the single place they're defined together, so they don't quietly diverge per-spec.

## 2. Assets

`GET /assets/:symbol`
Returns current snapshot (class, market cap, supply) plus a link to historical data. Used by `003 Pair Analysis` to hydrate underlying asset data when not already cached client-side from a prior pair lookup.

## 3. Pairs

`GET /pairs/:assetA/:assetB?window=30|90|200`
Full pair statistics object (`pair_metrics` row) for the given canonical window. Defaults to 90d. Used by `003 Pair Analysis`.

`GET /pairs/:assetA/:assetB/history?window=`
Time series for the return/price chart and delta series. Used by `003`.

## 4. Search

`GET /search?q=`
Grouped results — assets, direct pair matches, pools where applicable. Includes inline canonical 90d ORT scores on pair results (joined server-side, not N+1 per result). Used by `002 Search`.

## 5. ORT

`GET /pairs/:pairId/ort?window=30|90|200`
Current ORT score, component breakdown, quadrant label, and trend direction for a pair, for one canonical window. Defaults to 90d. Used by `004 ORT Engine`, and the `ORTPreviewChip`/`ORTContextChip` components in `003`/`006`.

`GET /pairs/:pairId/ort/history?window=30|90|200`
Historical ORT scores for one window, for the sparkline. Used by `004`.

`GET /pairs/ort?sort=desc&window=90&limit=`
Ranked list of pairs by ORT score within a single window. Used directly by `001 Dashboard`'s Top Opportunities panel and `004`'s Pair Explorer sort — both consume this same endpoint rather than maintaining separate rankings.

## 6. Pools

`GET /pairs/:assetA/:assetB/pools?chain=&dex=&feeTier=&minTvl=`
Filtered pool list for a pair. Used by `005 Pool Explorer`.

`GET /pools/:poolId`
Single pool detail, including active liquidity distribution. Used by `005`.

`GET /pools/:poolId/history?window=`
TVL/volume time series for the pool detail panel. Used by `005`.

## 7. Backtester

`POST /backtest`
Body: pair, range (min/max or %-width), period, optional pool/fee-tier. Returns fees earned, IL estimate, net P&L, time-in-range %, exit timeline. Used by `006 Backtester`.

`GET /backtest/:simulationId`
Retrieve a previously run, persisted simulation (`backtest_results` row). Used by `006` for scenario comparison and revisiting past runs.

## 8. What's Not Here

**No `/watchlists/*` endpoints, by design.** Per the local-storage-only auth decision, watchlists are handled by a client-side storage module (see `007 Watchlists`'s API Requirements), not REST endpoints, for this phase. That module still calls `GET /pairs/:pairId/ort` (§5) to hydrate live scores — it's local-storage for list membership, not for score data. Real `/watchlists/*` endpoints get added once wallet-based auth lands; `007` specifies the interface shape that future endpoints should mirror so the swap doesn't ripple into the frontend components.

## 9. Open Items

- Rate limiting and caching headers (e.g. reflecting the `computed_at` / refresh-cadence model from `Database.md` §5) aren't specified yet — responses should probably surface `computed_at` so the frontend can show data freshness, but the exact header/field convention isn't decided.
- Error response shape (4xx/5xx body format) isn't standardized yet across the endpoints above.
- `001 Dashboard`'s "recently viewed" endpoint (`GET /users/:userId/recently-viewed`) has the same `userId` assumption Watchlists had — not yet reconciled with the local-storage-only decision. Flagged, not fixed.
