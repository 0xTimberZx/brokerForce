# 020 — Time-Series Score Trend (ORT momentum off `ort_score_history`)

> **Status: Drafted 2026-10-09.** Adds a genuine *time-series* trend — is a pair's
> ORT score **rising or falling over recent days** — computed from the
> `ort_score_history` series. This is distinct from the existing
> `trend_direction`, which (despite the name) is a **30d-vs-90d quadrant/regime
> comparison within a single run**, not movement over time. Both are kept; they
> answer different questions.

## Why
A trend-direction audit (2026-10-09) found `trend_direction = flat` for 89 of 97
pairs. That's *correct* for the quadrant metric — those pairs sit in the same
quadrant across the 30d and 90d windows — but it does **not** answer the question
most people read into "trend": *is this opportunity getting better or worse lately?*
E.g. ADA/SOL's ORT score jumped **+6.0 in two days** yet reads `flat`, because it
stayed in `prime` both windows. The data to answer the real question already
exists: `ort_score_history` holds **19,830 rows over 75 days** (97 pairs × 3
windows, Jul 13 → Oct 9) and backs the 004 sparkline — but nothing derives a trend
from it.

## What exists
- `ort_score_history (pair_id, "window", score, quadrant_label, trend_direction,
  confidence, computed_at)` — one row appended per pair/window per pipeline run
  (`apps/ort-engine/src/db.ts::appendOrtScoreHistory`).
- `routes/ort.ts` already serves a history endpoint (score/quadrant over time) for
  the sparkline.
- Cadence is **irregular** — daily when the pipeline runs, with gaps when it
  doesn't (e.g. the Sep-24→Oct-7 GitHub-cron drop, now backstopped by spec-019's
  watchdog). The trend math must tolerate uneven spacing and gaps.

## The metric — `score_trend`
Per (pair, window): the **least-squares slope of `score` vs time** over a trailing
lookback, classified `rising` / `falling` / `flat` with a deadband.

- **Lookback:** `SCORE_TREND_LOOKBACK_DAYS = 14` (recent momentum; constant).
- **Points:** all `ort_score_history` rows for that (pair, window) with
  `computed_at >= now() - 14d`, **plus** the current run's just-computed score as
  the `t = 0` point. Least-squares over `(dayOffset, score)` — uneven spacing is
  handled naturally.
- **Minimum evidence:** need **≥ 3 points** spanning **≥ 5 days**; otherwise
  `score_trend = NULL` (surfaced as "building", not a direction). This avoids
  calling a trend off three points all from today, and degrades cleanly through
  the post-gap sparse period.
- **Classification (documented deadband, in the spirit of `score.ts`'s
  trendScore — simple and explainable over a "principled" curve):**
  - `projectedChange = slope × 14` (points of score over the lookback).
  - `projectedChange ≥ +2.5` → `rising`; `≤ −2.5` → `falling`; else `flat`.
  - `SCORE_TREND_EPSILON = 2.5` points (a change smaller than this over two weeks
    is noise, not a trend).
- **Stored alongside:** `score_trend_change` = `projectedChange` (numeric, pts over
  the lookback), so the UI can show "+6.1 over 14d", and NULL when `score_trend`
  is NULL.

### Honest caveat (documented in code + ORT.md)
The ORT score is **relative** — its components are percentile ranks against the
*current* population (`score.ts`). So `score_trend` is **momentum relative to
peers**: a pair can read `rising` because its own metrics improved *or* because
the field around it weakened. That's still a useful "getting more/less attractive
vs the universe" signal, but it is **not** an absolute-fundamentals trend, and the
copy must not imply otherwise.

## Why keep BOTH trends
They measure different things and are both legitimate:
- **`trend_direction`** (quadrant): *where* the pair sits — near-term regime
  (30d) vs longer-term (90d). "Is it structurally prime-like right now?"
- **`score_trend`** (this spec): *which way it's moving* over recent days. "Is it
  getting better or worse lately?"

**Decision:** add `score_trend` alongside; do **not** remove `trend_direction`.
To kill the naming confusion, surface them with distinct labels — e.g. **"Regime"**
(quadrant trend) and **"Momentum"** (score trend) — rather than two things both
called "trend". (Open question for review: is the quadrant trend still worth
*showing* once momentum exists, or demote it to the detail view?)

## Design — computed in `compute-ort.ts`
A **third pass**, after scores are computed and history is written:
1. The existing passes compute scores + quadrant trend and `appendOrtScoreHistory`
   (so the current point is persisted).
2. New pass: for each (pair, window), `SELECT score, computed_at FROM
   ort_score_history WHERE pair_id=$1 AND "window"=$2 AND computed_at >= now()-14d
   ORDER BY computed_at` → pure `computeScoreTrend(points)` → `UPDATE ort_scores
   SET score_trend=$1, score_trend_change=$2 WHERE pair_id AND window`.
   (Reading from history after the append means the current point is included with
   no special-casing; dedupe exact-duplicate timestamps defensively.)
- Pure function `computeScoreTrend(points: {t: Date, score: number}[]):
  { trend: ScoreTrend | null, change: number | null }` in a new
  `apps/ort-engine/src/score-trend.ts` — unit-tested (rising/falling/flat,
  below-epsilon→flat, <3 points→null, <5-day span→null, irregular spacing, a gap
  in the middle).

## Migration `016_score_trend.sql`
```sql
CREATE TYPE score_trend AS ENUM ('rising', 'falling', 'flat');
ALTER TABLE ort_scores        ADD COLUMN score_trend score_trend;
ALTER TABLE ort_scores        ADD COLUMN score_trend_change numeric;
-- history table also carries it, mirroring trend_direction, so the series keeps a
-- full record (and a future "momentum sparkline" has the data):
ALTER TABLE ort_score_history ADD COLUMN score_trend score_trend;
ALTER TABLE ort_score_history ADD COLUMN score_trend_change numeric;
```
Nullable (NULL = not enough history yet). Additive; nothing else changes. This is
an app-chain migration (next number after 015), applied by the repo's own migrate
runner.

## Changes (summary)
- `packages/db/migrations/016_score_trend.sql` (new).
- `apps/ort-engine/src/score-trend.ts` (new, pure) + tests.
- `apps/ort-engine/src/compute-ort.ts`: third pass computing + updating
  `score_trend`/`score_trend_change`; include the fields in the history append.
- `apps/ort-engine/src/db.ts`: thread the two new columns through the ort_scores
  upsert and the history insert.
- `packages/types`: `ScoreTrend = "rising"|"falling"|"flat"`; add
  `scoreTrend: ScoreTrend | null` + `scoreTrendChange: number | null` to `OrtScore`
  (and the ranked/analysis types that already carry `trendDirection`).
- `apps/api/src/routes/ort.ts`: select + map the two fields (detail + ranked).
- `apps/web`: surface **Momentum** (↑ rising / ↓ falling / → flat, with the
  `+X.X / 14d` figure) next to the existing regime trend, wherever `trendDirection`
  is shown (Top Opportunities, Pair Analysis). Label the two distinctly.
- `docs/ORT.md` + `docs/Analytics.md`: document the new metric + the relative-score
  caveat; clarify "regime trend" vs "momentum".

## Acceptance criteria
- [ ] Migration applies (enum + 4 columns, all nullable); app-chain migrate run clean.
- [ ] After a pipeline run, `score_trend` is populated for pairs with ≥3 history
      points spanning ≥5 days; NULL (building) otherwise — no crash on sparse pairs.
- [ ] A pair whose score genuinely climbed (e.g. an ADA/SOL-like +6/14d) reads
      `rising`; a stable blue-chip reads `flat`; a decaying pair `falling`.
- [ ] `score_trend_change` matches the projected 14d change; sign agrees with the label.
- [ ] Existing `trend_direction` unchanged; both surface in the API + UI with
      distinct labels.
- [ ] Pure `computeScoreTrend` unit-tested; typecheck/lint/build/full suite pass;
      scratch-Postgres e2e applies the migration + a seeded-history trend computes.

## Verification
Unit tests for `computeScoreTrend` (the classification + guards above).
Scratch-Postgres e2e: seed `ort_score_history` with a rising, a falling, a flat,
and a sparse (<3-pt) series across irregular timestamps; run the trend pass; assert
the four labels + the NULL. Live: a `workflow_dispatch` run, then query the
`score_trend` distribution and spot-check a known mover (ADA/SOL) reads `rising`
with a sane `score_trend_change`.

## Out of scope
- A momentum **sparkline** UI (the history columns make it possible later).
- Retiring/relabelling `trend_direction` in the UI beyond adding a distinct label
  (a product-copy pass, if wanted, is its own small change).
- Trend on individual component scores (only the composite score here).
