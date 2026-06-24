# ORT — Opportunity Risk/Time

## 1. What ORT Is

ORT is BrokerForce's composite score for ranking pair quality — a single 0–100 number that folds Opportunity, Risk, and Time into something comparable across pairs. It is not a price prediction. It's a structural read of how a pair has actually behaved.

## 2. Inputs and Weighting

Seven components, each independently weighted (weights live in config, not hardcoded in the frontend — see `Architecture.md` §4):

- Range Stability
- Time in Range
- Correlation
- Liquidity
- Volume
- Volatility
- Market Cap Stability

**Current approach to weights:** hand-picked to start, not data-derived. This is the right starting point — there isn't yet enough historical outcome data to validate weights statistically, and hand-picked, documented weights are more defensible and easier to revise than an opaque fitted model. Revisit once enough backtest/outcome history accumulates to test whether the weights actually predict good LP outcomes.

## 3. Canonical Windows

ORT is computed and stored on three fixed windows per pair — **30d, 90d, 200d** — each scored independently, not blended. **90d is the default** anywhere a single score is shown.

This is deliberate: a freely user-selectable window would make pairs incomparable to each other (whose "ORT score" would even mean the same thing?). The three-window set keeps a stable comparison basis while still letting someone check whether a pair's standing is consistent across timeframes or only looks good in one of them.

## 4. Refresh Cadence

Refresh frequency scales with window length rather than running on one global timer:

| Window | Refresh cadence |
|---|---|
| 30d | every 30 minutes |
| 90d | hourly |
| 200d | every 4 hours |

Rationale: a 30d average is sensitive to recent data and stale quickly; a 200d average is structurally slow-moving, so refreshing it as often as the 30d window would burn compute for no real signal change. *(This mapping is a first pass — confirm it holds once real load/compute costs are visible.)*

## 5. Pair Scope — Not Every Pair Gets Full Treatment

The Pair Engine generates many combinations, but ORT computation is tiered:

- **Active/popular pairs** (real trading and pool activity) get the full seven-component computation across all three windows.
- **Other generated combinations** remain explorable in the product, but show a visibly limited/lighter analysis rather than a full ORT score — the UI should make clear this is a lighter read, not imply equivalence with fully-scored pairs.
- **Stable–stable pairs** (e.g. USDC/USDT) are explicitly excluded from full critical-analytics treatment. Their risk/volatility profile is structurally uninteresting for LP decision-making at this product's level of rigor — computing a full ORT score for them would dilute rankings with technically-safe, practically-irrelevant results.

## 6. Qualitative Labeling — Quadrant + Trend

A single linear label (Poor/Fair/Good/Strong) hides too much — a pair can be "good" for very different reasons (safe-but-slow vs. active-but-volatile), and those aren't the same kind of good. Instead, ORT's qualitative label places a pair on a two-axis grid:

| | Low Volatility | High Volatility |
|---|---|---|
| **High Volume** | **Prime** — strong, predictable fee capture; the easy recommendation | **Active** — good fee opportunity, but expect more rebalancing |
| **Low Volume** | **Quiet** — safe, but likely capital-inefficient | **Avoid** — weak fee capture and high risk together |

*(Quadrant names above are a first pass — rename freely.)*

**Volume axis:** derived from the pair's volume field set (`avg_volume_24h/7d/30d`, `volume_stability`, `volume_trend`), normalized into Low/High relative to other active pairs.

**Volatility axis:** derived from Historical Volatility for the selected canonical window.

**Trend overlay:** alongside the quadrant, a directional indicator shows whether the pair is moving *toward* or *away from* the Prime quadrant over a recent comparison period (e.g. comparing 30d position against 90d position). This is what answers "is now a good time," separate from "is this generally a good pair" — a pair sliding from Active toward Prime is a different signal than one sliding from Prime toward Avoid, even if their current quadrant looks similar at a glance.

**Relationship to the 0–100 score:** the quadrant + trend is a presentation layer on top of the existing numeric ORT score — it does not replace it. The underlying score still aggregates all seven weighted components per `004 ORT Engine`'s spec; the quadrant is a simplified, two-axis read of (mostly) the Volume and Volatility components specifically, optimized for "what kind of opportunity is this" rather than "exactly how good is it."

## 7. Open Items

- Confirm the refresh-cadence mapping in §4 once compute cost is visible at real scale.
- Decide the actual normalization thresholds for "Low" vs. "High" on both axes (relative to the active-pair population, a fixed historical baseline, or something else) — not yet specified.
- Decide the comparison window for the trend overlay (30d-vs-90d suggested above, not finalized).
