# Analytics

## 1. What This Document Covers

`ORT.md` defines the composite score and how it's used. This document defines **how the underlying metrics are actually computed** — the methodology each pair statistic is built from — and resolves the open items `ORT.md` deferred here: weight values, axis normalization, and the trend comparison window.

## 2. Metric Definitions

| Metric | Definition |
|---|---|
| Daily Delta | Difference between each asset's daily return on a given day. |
| Average Delta | Mean of Daily Delta across the selected window. |
| Historical Volatility | Standard deviation of returns over the window, computed per-asset and at the pair level. |
| Correlation | Pearson correlation coefficient of the two assets' returns over the window. |
| Beta | Sensitivity of Asset A's returns relative to Asset B's (regression slope). |
| Cointegration Score | Statistical measure of whether the pair's price relationship is stable over time, beyond simple correlation — flags relationships that look correlated short-term but drift apart structurally. |
| Relative Strength | Cumulative performance of one asset versus the other over the window. |
| Liquidity | Trading volume / depth available for the pair. |
| TVL | Total value locked, if an LP pool exists for the pair (pulled from Pool data, not estimated). |
| Pair Popularity | Composite of swap frequency, LP count, and volume — a usage signal, distinct from the statistical metrics above. |
| Market Cap Ratio | Relative market cap of Asset A vs. Asset B, and how stable that ratio has been over the window. |
| Historical Range Stability | % of time, historically, the pair's relative price stayed within ±2% / ±5% / ±10% / ±15% bands. |
| Average Time In Range | Mean number of consecutive days a position would have stayed within a chosen range, historically. |
| Estimated Rebalances | Average number of range exits per year, derived from Range Stability and Time in Range. |
| Impermanent Loss Estimate | Historical IL estimate based on price divergence between the two assets over the window. |
| Fee Opportunity | Estimated fees based on volume, TVL, and range width. |
| Volume Field Set | `avg_volume_24h/7d/30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`, `fee_opportunity_score` — see `Architecture.md` §4 for the full field list. |

All of the above are computed per pair, per canonical window (30d/90d/200d) where window-dependent, consistent with `ORT.md` §3.

## 3. ORT Component Weights — First Pass

Hand-picked starting weights, not yet data-derived (per `ORT.md` §2's stated approach: defensible and revisable now, validated against outcomes later):

| Component | Weight |
|---|---|
| Volume | 20% |
| Range Stability | 20% |
| Volatility | 15% |
| Time in Range | 15% |
| Correlation | 10% |
| Liquidity | 10% |
| Market Cap Stability | 10% |

Volume and Range Stability are weighted highest, deliberately — they're the two metrics most directly tied to whether an LP actually earns fees without constant rebalancing, which is the core decision this product exists to support. This table is a first pass; revisit once enough backtest outcome data exists to test whether these weights actually correlate with good real-world LP results.

## 4. Resolving the Open Items from ORT.md §7

**Axis normalization (Volume/Volatility, for the quadrant label):** use **percentile-based normalization relative to the current population of active/popular pairs** (per `Architecture.md`'s Pair Engine tiering — excludes stable–stable and limited-tier pairs from the comparison set). A pair is "High Volume" if it sits above the median volume among active pairs in the same canonical window; "Low" otherwise. Same approach for Volatility. Percentile-based (vs. a fixed absolute threshold) keeps the labels meaningful as the overall market changes, rather than going stale if, say, volume across the board rises or falls broadly.

**Trend overlay comparison window:** compare a pair's **30d quadrant position against its 90d quadrant position**. Moving from Active (90d) toward Prime (30d) reads as "improving, good time to look closer"; the reverse reads as "cooling off." 200d is intentionally excluded from the trend comparison — it changes too slowly to produce a meaningful near-term trend signal.

## 5. Data Sufficiency / Low-Confidence Handling

Given BrokerForce's progressive data buildout, every metric above needs a minimum history threshold before it's considered reliable enough to display normally:

- A metric computed on a window with **less history than the window itself** (e.g. a 90d metric on a pair with only 40 days of tracked history) is flagged **low confidence** rather than computed on the partial data and shown as if complete.
- The 200d window will hit this condition far more often than 30d during the project's early life — this is expected, not a bug, and should be communicated as such in the UI (`004 ORT Engine` already requires this per its acceptance criteria) rather than hidden.
- Stable–stable pairs and limited-tier pairs (per `ORT.md` §5) are excluded from this calculation entirely — they don't get a confidence rating because they don't get a full computation in the first place.

## 6. What This Document Doesn't Cover

Composite scoring logic and the quadrant model itself → `ORT.md`. Storage schema and refresh implementation → `Database.md`. API shape for exposing these metrics → `API.md`.
