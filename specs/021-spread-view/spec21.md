# 021 — Spread View (relative-performance trend + hedge ratio, per pair)

> **Status: Drafted 2026-10-17.** Adds a **Spread** read for any pair: how one
> asset has performed *against* the other over each canonical window, whether
> that relative move is a real drift or just noise, and the historical hedge ratio
> and hedge effectiveness between the two legs, oriented whichever way round the
> user picks. It is descriptive and backward-looking, like everything else in
> BrokerForce. It is **not** a trade signal and makes no forecast
> (`Product_Principles.md` §5).

## Why
The LP lens (ORT) asks *"will this pair stay in range?"* A second, common question
about the same two assets is the opposite one: *"which side has been winning, by
how much, and how well does one leg offset the other?"* People ask it when
weighing a relative-value position, such as holding an alt against a blue chip so
that market-wide swings largely cancel.

Spec 020 showed that ORT momentum can't answer this. A rising ORT score means the
pair is getting *calmer*, not that either side is leading. The raw ingredients
already exist in `pair_metrics`, but they are scattered and partly mis-oriented
for this use:

- `relative_strength` is an **endpoint** log-return gap. One spiky first or last
  day can swing it, and it says nothing about whether the gap is large relative to
  the spread's normal noise. A 15-point gap with 2% daily spread volatility is a
  very different fact from the same gap with 8%.
- `beta` is A-on-B only, in **alphabetical** order. For `BTC/NEAR` it reads 0.13,
  which is BTC's sensitivity to NEAR, not the hedge ratio someone holding NEAR
  against BTC needs (≈1.4). Users can't flip it.
- Hedge effectiveness (corr²) and the residual volatility of a hedged position
  aren't surfaced anywhere.

An ad-hoc pull on 2026-10-15 (alt vs blue-chip, 90d) showed why the combination
matters. NEAR led every major by 60–70 log points but had only 0.42–0.56
correlation, so a hedge cancels under a third of its swings. ADA vs XRP led by a
modest +15 but steadily, at 0.80 correlation, so a hedge cancels 64% of the
swings. Neither the endpoint gap nor ORT shows that difference.

## What exists
- `asset_price_history` holds daily closes (inner-joined by date in
  `compute-metrics.ts::alignByDate`).
- `pair_metrics` per (pair, window) holds `correlation`, `beta` (A on B),
  `cointegration_score` (proxy), `relative_strength` (endpoint), and
  `historical_volatility` (stdev of the daily return gap).
- `packages/stats` is shared by `apps/pair-engine` and `apps/api`. New pure math
  goes there, which avoids another copy like the inline delta series in
  `routes/pairs.ts`.
- `GET /pairs/:a/:b/history` already returns the aligned close series. Pair
  Analysis (`003`) already renders `PairReturnChart` and `StatisticsSummaryGrid`.

## The metrics
Notation: for a pair viewed as **X against Y** (X = primary leg, Y = hedge leg),
the spread is `s(t) = ln(close_X(t) / close_Y(t))`, and daily spread changes are
`Δs(t) = r_X(t) − r_Y(t)` in log returns. Over a canonical window of `n` aligned
days:

1. **Spread drift**: the OLS slope of `s(t)` against the day index, projected over
   the window: `spread_change = slope × n`, in log points. It uses every day, not
   just the two endpoints, so it's robust to one odd day. A positive value means X
   outperformed Y.
2. **Drift strength**: `spread_change / (stdev(Δs) × √n)`. This compares the
   drift with how far a random walk of the spread's own daily volatility
   typically wanders over `n` days. It is dimensionless and comparable across
   pairs and windows.
3. **Spread trend label** (deadband, in the spirit of 020's classification):
   - strength ≥ **+1.0** → `x_leading`
   - strength ≤ **−1.0** → `y_leading`
   - otherwise → `no_clear_trend`

   `SPREAD_TREND_STRENGTH_THRESHOLD = 1.0` means "moved at least as far as the
   spread's own noise would typically move it." It's a documented constant, not
   a p-value.
4. **Persistence** compares the 30d and 90d drift for the same orientation:
   - `consistent`: same sign, and both windows clear the threshold.
   - `fading`: same sign, but the 30d daily drift rate (`slope`) is less than half
     the 90d rate.
   - `reversing`: the 30d label is the opposite direction from the 90d label.
   - `none`: anything else, including when either window has no clear trend.
5. **Hedge ratio** (`β_X|Y`): the OLS slope of `r_X` on `r_Y`, meaning how many
   units of Y-exposure offset one unit of X-exposure for shared moves. It's
   stored in **both** directions and computed directly, not derived, so it stays
   exact.
6. **Hedge effectiveness**: `corr²`, the share of X's daily variance that a
   β-sized Y position cancels. It's symmetric.
7. **Residual volatility**: annualised stdev of the β-hedged daily return,
   `stdev(r_X − β_X|Y · r_Y) × √365`. This is "how much this hedged position still
   swings." It depends on direction, so it's stored for both orientations.

### Honest caveats (shown in the UI, documented in code)
- **Backward-looking.** These describe what the spread *did*. A trend label is not
  a forecast, and nothing here recommends taking a position.
- **No mean-reversion claim.** The cointegration proxy reads near 0 for most
  pairs, meaning most spreads trend rather than snap back. The view must not
  frame a stretched spread as "due" to revert.
- **Daily closes only.** Intraday swings, gaps, funding rates, borrow costs and
  liquidation mechanics are invisible here (see Out of scope).
- **Hedge ratios drift.** β is a window estimate. The 30d and 90d values are shown
  side by side so instability is visible, not hidden.

## Design

### Compute: `apps/pair-engine` (stored, per pair × window)
Spread metrics are computed in the existing `computeForPairAndWindow` pass, so
they're stored in `pair_metrics` and available to rankings and the screener
without recomputing price history per request.

- New pure functions in `packages/stats`, unit-tested:
  - `spreadDrift(closesX, closesY): { change, slope, strength } | null`. Returns
    null when there are fewer than `MIN_POINTS_FOR_STATS` points or the spread has
    zero variance.
  - `classifySpreadTrend(strength): 'x_leading' | 'y_leading' | 'no_clear_trend' | null`
  - `residualVol(returnsX, returnsY, beta): number` (annualised).
  - `spreadPersistence(w30, w90): 'consistent' | 'fading' | 'reversing' | 'none' | null`
    is pure and lives here, but it is **applied at read time** because it needs
    both windows.
- Everything is stored in **canonical orientation** (A against B, alphabetical).
  The API flips to the user's orientation (see below), so storage stays at one row
  per pair/window and the flip is exact:
  - `spread_change`, `spread_strength`, and `spread_trend` flip by negation or
    swap.
  - `beta` is already A on B. A new `beta_b_on_a` is computed directly.
  - `residual_vol_a` (A hedged with B) and `residual_vol_b` (B hedged with A).

### Migration `017_spread_metrics.sql`
```sql
CREATE TYPE spread_trend AS ENUM ('a_leading', 'b_leading', 'no_clear_trend');
ALTER TABLE pair_metrics ADD COLUMN IF NOT EXISTS beta_b_on_a     NUMERIC;
ALTER TABLE pair_metrics ADD COLUMN IF NOT EXISTS spread_change   NUMERIC; -- log pts over window, A vs B
ALTER TABLE pair_metrics ADD COLUMN IF NOT EXISTS spread_strength NUMERIC; -- drift / (σ_Δs·√n)
ALTER TABLE pair_metrics ADD COLUMN IF NOT EXISTS spread_trend    spread_trend;
ALTER TABLE pair_metrics ADD COLUMN IF NOT EXISTS residual_vol_a  NUMERIC; -- annualised, A hedged with B
ALTER TABLE pair_metrics ADD COLUMN IF NOT EXISTS residual_vol_b  NUMERIC; -- annualised, B hedged with A
```
All columns are nullable and additive. They backfill on the next `compute-metrics`
run, with no history table needed, because they're recomputed from price history
every run.

### API
- **`GET /pairs/:x/:y/spread?window=30|90|200`**: path order **is** the
  orientation (`x` against `y`). It is not canonicalised, unlike `/history`. It
  returns:
  ```ts
  interface PairSpreadResponse {
    pairId: string;
    primary: string;   // x
    hedge: string;     // y
    window: CanonicalWindow;
    spreadChange: number | null;     // log pts, + = primary outperformed
    spreadStrength: number | null;
    spreadTrend: "primary_leading" | "hedge_leading" | "no_clear_trend" | null;
    persistence: "consistent" | "fading" | "reversing" | "none" | null; // 30d vs 90d
    hedgeRatio: number | null;       // β primary|hedge
    hedgeRatio30: number | null;     // shown beside the selected window for stability
    hedgeRatio90: number | null;
    hedgeEffectiveness: number | null; // corr²
    residualVol: number | null;      // annualised, primary hedged with hedge
    primaryVol: number | null;       // annualised, unhedged, for comparison
    cointegrationScore: number | null;
    confidence: "full" | "low";
    series: { date: string; spread: number; fitted: number }[]; // rebased: spread(0)=0
  }
  ```
  The scalar fields come from stored `pair_metrics` (flipped as needed).
  Persistence comes from joining the 30d and 90d rows. `series` and `fitted` are
  computed from the aligned closes using the same `packages/stats` functions, so
  chart and stats can't disagree.
- **`GET /pairs/spreads`** (screener, Phase 2):
  `?window=90&primaryClass=growth-exotic&hedgeClass=blue-chip&minEffectiveness=0.5&sort=strength&limit=25`.
  It orients each matching pair so the primary leg is from `primaryClass`, flips
  stored values accordingly, filters by `corr² ≥ minEffectiveness`, and sorts by
  `|strength|` (default), effectiveness, or residual vol. Stable–stable and
  commodity pairs are excluded unless a class filter explicitly names them. It must
  be registered **before** `pairsRouter` (same route-ordering rule as
  `/pairs/ort`).

### Web
- **Pair Analysis → new "Spread" panel**, below `PairReturnChart`:
  - **Orientation toggle**: "`X` against `Y`" ⇄ "`Y` against `X`". The default is
    the URL order. The toggle swaps legs client-side by re-requesting with the
    reversed path.
  - **Spread chart**: the rebased log-ratio line, plus the OLS fit as a dashed
    line. The y-axis is labelled "`X` vs `Y` (log pts)", with a zero reference
    line.
  - **Tiles**: Spread drift (`+15.2 / 90d`), Trend label + strength (`X leading ·
    1.8σ`), Persistence, Hedge ratio (selected window, with the 30d and 90d values
    in small type), Hedge effectiveness (`64% of swings offset`), Residual vol vs
    unhedged vol (`38% → 23% ann.`).
  - **Caveat line**, always visible: *"Historical relative performance, not a
    forecast or a recommendation. Daily closes only; excludes funding and borrow
    costs."*
  - The same low-confidence treatment as the rest of the page when the window has
    less history than its length.
- **Spreads screener** (Phase 2): a compact table on the Dashboard, or a
  `/spreads` page, with class pickers ("Alts vs Blue chips" preset),
  min-effectiveness slider, and sortable columns. Each row links to the pair's
  Spread panel in that orientation.
- Colours follow the existing discipline. The ORT signal accent is **not** used,
  since spread is a separate lens, and leading/lagging use `text-ink` and
  `text-ink-muted` rather than green and red, to avoid buy/sell connotations.

### Docs
- `docs/Analytics.md`: new **§2a Spread metrics** with the definitions, threshold
  and caveats above, plus a note that `relative_strength` (endpoint) stays for
  continuity but the panel uses `spread_change` (OLS).
- `docs/API.md`: the two endpoints.
- `docs/Glossary.md`: spread, hedge ratio, hedge effectiveness, residual vol.

## Phasing
- **Phase 1:** migration 017, the `packages/stats` functions with tests,
  pair-engine compute, `GET /pairs/:x/:y/spread`, and the Pair Analysis Spread
  panel. This covers the per-pair question end to end.
- **Phase 2:** `GET /pairs/spreads` plus the screener UI. It's a read-only query
  over Phase 1's stored columns, so there's no new compute.

## Acceptance criteria
- [ ] Migration 017 applies (enum plus 6 nullable columns) on scratch Postgres and
      via the app-chain runner. `compute-metrics` populates them for every pair
      with ≥ `MIN_POINTS_FOR_STATS` aligned days.
- [ ] `spreadDrift` / `classifySpreadTrend` / `residualVol` / `spreadPersistence`
      are unit-tested: a synthetic steady uptrend reads `x_leading`, a downtrend
      `y_leading`, and a pure random walk at the same σ reads `no_clear_trend` in
      the large majority of seeds. A single spiky endpoint doesn't flip the label
      (where `relative_strength` would). Zero variance and short series return
      null. Residual vol is ≤ unhedged vol whenever corr > 0.
- [ ] **Orientation is exact:** for any pair, `/spread` with `x/y` and with `y/x`
      give negated `spreadChange`/`spreadStrength`, swapped trend labels,
      `hedgeRatio` equal to the directly computed reverse β (not 1/β), and the
      matching residual vol. Covered by an API test.
- [ ] `series.fitted` slope × n equals `spreadChange` (chart and tiles agree).
- [ ] Persistence is derived from the stored 30d and 90d rows, and is null when
      either is missing.
- [ ] The Spread panel renders on Pair Analysis with the orientation toggle, chart,
      tiles and caveat line. Low-confidence windows are flagged. Nothing on the
      panel uses imperative or buy/sell wording.
- [ ] Spot check against live data: NEAR vs BTC shows a large positive drift but
      low hedge effectiveness (< 0.35). ADA vs XRP shows a smaller drift with
      effectiveness ≈ 0.64.
- [ ] (Phase 2) The screener with the alts-vs-blue-chips preset returns
      alt-primary orientations only, filtered by effectiveness and sorted by
      |strength|.
- [ ] Typecheck, lint, build and the full suite all pass.

## Verification
Unit tests for the pure functions (synthetic series with known slope and σ, plus a
seeded random-walk null check). A scratch-Postgres e2e that seeds two assets'
closes with a known log-drift, runs `compute-metrics`, and asserts the stored
spread fields and their flip through the API. Live check after a pipeline run:
query the spread distribution for the 90d window and spot-check the NEAR/BTC and
ADA/XRP cases above.

## Out of scope
- **Funding rates, borrow costs, liquidation and margin modelling.** There's no
  perp or lending data source yet. If one is ever added, it gets its own spec, and
  the caveat line names this gap until then.
- **Mean-reversion / z-score "stretch" signals and entry/exit levels.** These
  border on prediction (`Product_Principles.md` §5), and the cointegration proxy
  is too weak to support them honestly.
- **Position sizing or P&L simulation for a hedged position.** 006 Backtester is
  the place for that if it's ever wanted, and only as a historical replay.
- **Intraday granularity.** This follows the Stage-2 hourly upgrade with
  everything else.
- **A spread-trend time series** (like 020's history table). The current read is
  recomputed every run; a history can be added later if a sparkline is wanted.
