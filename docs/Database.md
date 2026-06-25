# Database

## 1. Stack

PostgreSQL for relational/structural data (Asset, Pair, Pool metadata, computed metrics). TimescaleDB (a Postgres extension) for time-series data (price history, volume history, ORT score history) — chosen specifically because this data is append-heavy, queried by time range, and benefits from continuous aggregates rather than ad hoc rollups computed at query time. Redis for short-lived cached reads (e.g. the current 90d ORT ranking, recomputed on the cadence defined in `ORT.md` §4, served from cache between refreshes rather than recomputed per request).

## 2. Data Granularity — Daily Now, Hourly Deferred

**Decided: daily granularity for price/volume history in the current phase, upgrading to hourly once `006 Backtester` is actually being built (Phase 3).**

This follows the same logic as the refresh-cadence decision in `ORT.md` §4 — don't build infrastructure ahead of the feature that needs it. Daily data was flagged as undercounting range exits for volatile pairs (`006`'s acceptance criteria), but that inaccuracy only matters once the Backtester exists to be inaccurate. Phases 1–2 (Pair Engine, Pair Analysis, ORT Engine) don't need finer-than-daily data — correlation, volatility, range stability, and ORT scoring all work fine on daily closes. Paying hourly's ~24x storage/ingestion cost across every tracked asset before anything consumes that precision would be cost paid for nothing.

**What this means in practice:** `006 Backtester` is not build-ready as currently specced until this upgrade happens — its spec already requires disclosing data granularity to the user (e.g. "based on daily closes") rather than overstating precision, so it can technically run on daily data now, but its acceptance criteria around accurate range-exit timing assume something closer to hourly. Treat the granularity upgrade as a prerequisite task when `006` actually enters the Build phase, not a nice-to-have.

Daily and the canonical windows (30d/90d/200d) are computed as continuous aggregates from the daily base. When the upgrade happens, hourly becomes the new base and daily/window aggregates roll up from that instead — existing daily history doesn't need to be discarded, just supplemented going forward.

## 3. Pool-Level Ingestion Intensity — Gated by Pair Tier

Asset-level price history (§2) is cheap and shared — there are only ~17 tracked assets regardless of how many pairs exist. **Pool-level data (TVL, on-chain volume, active liquidity from per-DEX/per-chain sources) is the real ongoing cost**, since it scales with the combinatorial pair/pool count, not the asset count — and most generated pair combinations will never actually be looked at by a user.

So pool-level ingestion is gated by the same tier defined on the `pairs` table in §5 below and `Architecture.md` §5's $50k TVL / $10k volume bar:

- **Active/popular tier:** pool data is continuously polled, on the cadence `ORT.md` §4 defines for the current ingestion stage.
- **Limited tier:** pool data is **not continuously polled or stored**. It's fetched live, on-demand, only when a user actually opens that pair in `005 Pool Explorer` — no standing ingestion cost for pairs nobody's looking at.
- **Excluded-stable tier:** same as limited — no persistent ingestion, live-fetch only if explicitly requested.

This keeps ingestion spend tied to actual market/user interest rather than the full combinatorial pair count, which would otherwise mean paying continuous polling cost for long-tail pairs that turn out not to be interesting long-term.

## 4. Retention Policy — No Cap For Now

Storage at current scale is genuinely cheap regardless of resolution: ~17 tracked assets at hourly granularity over a decade is roughly 1.5M rows; even 50 active-tier pools polled hourly for a year is well under a million rows. Both are trivial for TimescaleDB. Engineering a downsampling/retention policy now would be optimizing a cost that doesn't exist yet — the same instinct that's already kept BrokerForce from building wallet auth or a token before there's a reason to.

**Decided: no retention cap.** Keep all raw data indefinitely at whatever the current granularity is (daily now, hourly once `006` triggers the upgrade in §2). **Revisit once active-tier pool count exceeds 50, or once hourly granularity has been live for 9 months** — whichever comes first. At that point there's real usage data and real table sizes to size an actual downsampling policy against, instead of guessing now.

## 5. Core Tables

**`assets`**
`symbol`, `class` (blue chip / stable / growth-exotic / degen), `market_cap`, `circulating_supply`, `fully_diluted_value` — current snapshot fields; historical OHLCV lives in the time-series tables below, not here.

**`asset_price_history`** (TimescaleDB hypertable)
`asset_symbol`, `timestamp` (**daily** for now — see §2; upgrades to hourly when `006 Backtester` enters Build), `open`, `high`, `low`, `close`, `volume`. 30d/90d/200d aggregates derived via continuous aggregates, not stored redundantly as separate raw tables.

**`pairs`**
`asset_a`, `asset_b`, `tier` (active/popular vs. limited vs. excluded — active/popular requires at least one real pool with TVL ≥ $50,000 and 7-day average volume ≥ $10,000, per `Architecture.md`'s Pair Engine tiering decision; stable–stable pairs are `excluded-stable` regardless of meeting that bar, per `ORT.md` §5), `created_at`.

**`pair_metrics`**
`pair_id`, `window` (30d/90d/200d), `correlation`, `beta`, `cointegration_score`, `historical_volatility`, `relative_strength`, `range_stability_2pct/5pct/10pct/15pct`, `avg_time_in_range`, `estimated_rebalances`, `il_estimate`, `fee_opportunity`, plus the volume field set (`avg_volume_24h/7d/30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`), `confidence` (per `Analytics.md` §5's low-confidence flagging), `computed_at`.

**`ort_scores`**
`pair_id`, `window`, `score` (0–100), `quadrant_label`, `trend_direction`, `confidence`, `computed_at`. Kept as its own table (not folded into `pair_metrics`) since it's a derived composite, refreshed on its own cadence, and needs its own history for the sparkline (`004`).

**`pools`**
`pair_id`, `dex`, `chain`, `fee_tier`, `tvl`, `volume`, `active_liquidity`, `swap_count_7d`, `unique_lp_count` — the last two added specifically to back `Analytics.md`'s Pair Popularity formula; sourced from the same per-DEX/per-chain ingestion (Uniswap Subgraph, etc. all expose swap counts and position/LP counts) as the rest of this table, so no new ingestion *source* is needed, just two more fields pulled from sources already being queried. Subject to the same tier-gated ingestion as everything else in this table (§3) — only populated for active-tier pools.

**`pool_history`** (TimescaleDB hypertable)
`pool_id`, `timestamp`, `tvl`, `volume` — for `005 Pool Explorer`'s detail-panel trend view.

**`backtest_results`**
`id`, `pair_id`, `range_min`, `range_max`, `period_start`, `period_end`, `fee_tier`, `fees_earned`, `il_estimate`, `net_pnl`, `time_in_range_pct`, `exit_count`, `created_at`. Persisted per `006 Backtester`'s requirement that simulations be retrievable, not ephemeral-only.

## 6. What's Deliberately Not Here

**No `users` or `watchlists` table.** Per `Architecture.md` §5's auth decision, watchlists currently live in local browser storage, not the database. If/when wallet-based auth lands, this section needs a real schema for users and server-side watchlist sync — not built preemptively.

## 7. Refresh Behavior

`pair_metrics` and `ort_scores` are recomputed on the per-window cadence defined in `ORT.md` §4 — which is staged to match the granularity timeline in §2, not a fixed schedule. **Right now, with daily price/volume ingestion, all three windows effectively refresh daily** (refreshing faster than the underlying data changes would just recompute the same value). The hourly/hourly/4hr cadence described earlier in this project's planning applies once `006 Backtester` triggers the hourly granularity upgrade — see `ORT.md` §4 for the full staged timeline. Recomputation happens via scheduled jobs, not on read. The API layer (`API.md`) serves the most recently computed row plus its `computed_at` timestamp, so the frontend can show data as "as of" rather than implying live computation on every request.

Pool-level data (§3) follows a separate, tier-gated refresh model — not the window-based cadence above, since it's not computing a statistic over a window, just reflecting current on-chain state for active-tier pairs or live-fetching for everything else.

## 8. Open Items

- Trigger the hourly upgrade (§2) when `006 Backtester` actually enters the Build phase — don't build it before then.

§3's on-demand pool fetch timeout/fallback behavior is now resolved in `005 Pool Explorer`'s spec (5-second timeout, explicit error state, 10-minute result cache).
