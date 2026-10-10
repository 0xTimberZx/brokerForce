import type { ScoreTrend, TrendDirection } from "@brokerforce/types";

// The two ORT trend reads, side by side, labelled DISTINCTLY so they're never
// confused (spec 020):
//   - Regime   = quadrant trend_direction -- where the pair sits, near-term
//                (30d) vs longer-term (90d). "Is it structurally prime-like?"
//   - Momentum = score_trend -- which way the SCORE is moving over the last
//                14 days. "Is it getting better or worse lately?"
// Both are kept because they answer different questions. Momentum is relative
// to peers (the ORT score is percentile-based), so the title says so.

interface OrtTrendTagsProps {
  trendDirection: TrendDirection | null;
  scoreTrend: ScoreTrend | null;
  scoreTrendChange: number | null;
}

const REGIME: Record<TrendDirection, { glyph: string; label: string; title: string }> = {
  "toward-prime": { glyph: "↗", label: "toward prime", title: "Regime: moving toward the Prime quadrant (30d vs 90d)" },
  "away-from-prime": { glyph: "↘", label: "away from prime", title: "Regime: moving away from the Prime quadrant (30d vs 90d)" },
  flat: { glyph: "→", label: "regime flat", title: "Regime: same quadrant position over 30d and 90d" },
};

const MOMENTUM: Record<ScoreTrend, { glyph: string; cls: string }> = {
  rising: { glyph: "↑", cls: "text-pos" },
  falling: { glyph: "↓", cls: "text-neg" },
  flat: { glyph: "→", cls: "text-ink-muted" },
};

export function fmtTrendChange(change: number): string {
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  return `${sign}${Math.abs(change).toFixed(1)}`;
}

export function OrtTrendTags({ trendDirection, scoreTrend, scoreTrendChange }: OrtTrendTagsProps) {
  const regime = trendDirection ? REGIME[trendDirection] : null;
  const momentum = scoreTrend ? MOMENTUM[scoreTrend] : null;
  return (
    <>
      {regime && (
        <span className="text-[10px] uppercase tracking-wide text-ink-muted" title={regime.title}>
          {regime.glyph} {regime.label}
        </span>
      )}
      {momentum ? (
        <span
          className={`text-[10px] uppercase tracking-wide tabular-nums ${momentum.cls}`}
          title={`Momentum: score ${scoreTrend} over the last 14 days (relative to peers — the ORT score is percentile-based)`}
        >
          {momentum.glyph} {scoreTrendChange !== null ? `${fmtTrendChange(scoreTrendChange)} / 14d` : scoreTrend}
        </span>
      ) : (
        <span
          className="text-[10px] uppercase tracking-wide text-ink-muted italic"
          title="Momentum: not enough score history yet (needs 3+ points over 5+ days)"
        >
          momentum building
        </span>
      )}
    </>
  );
}
