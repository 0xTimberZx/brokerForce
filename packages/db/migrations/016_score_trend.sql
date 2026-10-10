-- 016: time-series score trend / "momentum" (spec 020).
--
-- trend_direction (001) is a 30d-vs-90d QUADRANT comparison within one run --
-- "where does the pair sit, near-term vs longer-term" -- not movement over time.
-- score_trend answers the other question people read into "trend": is this
-- pair's ORT score RISING or FALLING over recent days? It's derived from the
-- ort_score_history series (least-squares slope over a 14d lookback; see
-- apps/ort-engine/src/score-trend.ts). Both are kept: they measure different
-- things, surfaced as "Regime" (quadrant) vs "Momentum" (score).
--
-- NULL = not enough history yet (< 3 points or < 5 days of span) -- shown as
-- "building", never as a direction. score_trend_change is the projected change
-- in score points over the lookback, so the UI can say "+6.1 / 14d".
--
-- Additive: nothing else changes.

CREATE TYPE score_trend AS ENUM ('rising', 'falling', 'flat');

ALTER TABLE ort_scores ADD COLUMN IF NOT EXISTS score_trend score_trend;
ALTER TABLE ort_scores ADD COLUMN IF NOT EXISTS score_trend_change NUMERIC;

-- The history table carries it too, mirroring trend_direction, so the series
-- keeps a full record (and a future momentum sparkline has the data).
ALTER TABLE ort_score_history ADD COLUMN IF NOT EXISTS score_trend score_trend;
ALTER TABLE ort_score_history ADD COLUMN IF NOT EXISTS score_trend_change NUMERIC;
