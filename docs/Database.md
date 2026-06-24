# Database

## 1. Stack

PostgreSQL for relational/structural data (Asset, Pair, Pool metadata, computed metrics). TimescaleDB (a Postgres extension) for time-series data (price history, volume history, ORT score history) — chosen specifically because this data is append-heavy, queried by time range, and benefits from continuous aggregates rather than ad hoc rollups computed at query time. Redis for short-lived cached reads (e.g. the current 90d ORT ranking, recomputed on the cadence defined in `ORT.md` §4, served from cache between refreshes rather than recomputed per request).

## 2. Resolving the Open Granularity Question (Architecture.md §5)

**Proposal: hourly base granularity for price/volume history**, not daily, not intraday-tick-level.

Reasoning: daily-only data was already flagged as undercounting range exits for volatile pairs (`006 Backtester`). Full tick-level storage is unnecessary cost for what this product needs — an LP isn't making decisions at the second-by-second level. Hourly is the practical middle: materially better range-exit accuracy than daily, without the storage/ingestion cost of tick data across every tracked asset. Daily and the canonical windows (30d/90d/200d) become continuous aggregates computed from the hourly base, not separately ingested.

This is a proposal, not a confirmed decision — flagging it explicitly as resolving an open item rather than treating it as settled. Worth revisiting once real ingestion cost at hourly granularity across all tracked assets is actually measured.

## 3. Core Tables

**`assets`**
`symbol`, `class` (blue chip / stable / growth-exotic / degen), `market_cap`, `circulating_supply`, `fully_diluted_value` — current snapshot fields; historical OHLCV lives in the time-series tables below, not here.

**`asset_price_history`** (TimescaleDB hypertable)
`asset_symbol`, `timestamp` (hourly), `open`, `high`, `low`, `close`, `volume`. Daily/30d/90d/200d aggregates derived via continuous aggregates, not stored redundantly as separate raw tables.

**`pairs`**
`asset_a`, `asset_b`, `tier` (active/popular vs. limited vs. excluded — per `Architecture.md`'s Pair Engine tiering and `ORT.md` §5's stable-pair exclusion), `created_at`.

**`pair_metrics`**
`pair_id`, `window` (30d/90d/200d), `correlation`, `beta`, `cointegration_score`, `historical_volatility`, `relative_strength`, `range_stability_2pct/5pct/10pct/15pct`, `avg_time_in_range`, `estimated_rebalances`, `il_estimate`, `fee_opportunity`, plus the volume field set (`avg_volume_24h/7d/30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`), `confidence` (per `Analytics.md` §5's low-confidence flagging), `computed_at`.

**`ort_scores`**
`pair_id`, `window`, `score` (0–100), `quadrant_label`, `trend_direction`, `confidence`, `computed_at`. Kept as its own table (not folded into `pair_metrics`) since it's a derived composite, refreshed on its own cadence, and needs its own history for the sparkline (`004`).

**`pools`**
`pair_id`, `dex`, `chain`, `fee_tier`, `tvl`, `volume`, `active_liquidity`.

**`pool_history`** (TimescaleDB hypertable)
`pool_id`, `timestamp`, `tvl`, `volume` — for `005 Pool Explorer`'s detail-panel trend view.

**`backtest_results`**
`id`, `pair_id`, `range_min`, `range_max`, `period_start`, `period_end`, `fee_tier`, `fees_earned`, `il_estimate`, `net_pnl`, `time_in_range_pct`, `exit_count`, `created_at`. Persisted per `006 Backtester`'s requirement that simulations be retrievable, not ephemeral-only.

## 4. What's Deliberately Not Here

**No `users` or `watchlists` table.** Per `Architecture.md` §5's auth decision, watchlists currently live in local browser storage, not the database. If/when wallet-based auth lands, this section needs a real schema for users and server-side watchlist sync — not built preemptively.

## 5. Refresh Behavior

`pair_metrics` and `ort_scores` are recomputed on the per-window cadence defined in `ORT.md` §4 (30d: 30 min, 90d: hourly, 200d: 4 hr) via scheduled jobs, not recomputed on read. The API layer (`API.md`) serves the most recently computed row plus its `computed_at` timestamp, so the frontend can show data as "as of" rather than implying live computation on every request.

## 6. Open Items

- Confirm hourly granularity (§2) once real ingestion cost is measured — this is a proposal, not yet locked.
- Decide retention policy for raw hourly data (keep forever vs. downsample older history) — not yet addressed.
- `tier` field on `pairs` needs an actual definition of "active/popular" (a volume or TVL threshold, most likely) — referenced throughout but not numerically defined yet.
