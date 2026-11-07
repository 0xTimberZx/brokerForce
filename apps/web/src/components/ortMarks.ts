import type { OrtScore, QuadrantLabel, ScoreTrend } from "@brokerforce/types";
import { fmtTrendChange } from "./OrtTrendTags";
import { networkName } from "./networks";

// Compact ORT reads shared by the dashboard rows and compact chips: the signal
// as a mark rather than a word, momentum as one arrow, and the rest in a
// title. Kept monochrome: amber stays reserved for the score, green/red for
// direction (tailwind.config).

export const SIGNAL_MARK: Record<QuadrantLabel, { glyph: string; cls: string }> = {
  prime: { glyph: "●", cls: "text-ink" },
  active: { glyph: "●", cls: "text-ink-muted" },
  quiet: { glyph: "○", cls: "text-ink-muted" },
  avoid: { glyph: "×", cls: "text-ink-muted" },
};

export const MOMENTUM: Record<ScoreTrend, { glyph: string; cls: string }> = {
  rising: { glyph: "↑", cls: "text-pos" },
  falling: { glyph: "↓", cls: "text-neg" },
  flat: { glyph: "→", cls: "text-ink-muted" },
};

const REGIME_TEXT = {
  "toward-prime": "moving toward prime (30d vs 90d)",
  "away-from-prime": "moving away from prime (30d vs 90d)",
  flat: "flat (30d vs 90d)",
} as const;

type Detail = Pick<OrtScore, "quadrantLabel" | "trendDirection" | "scoreTrend" | "scoreTrendChange" | "confidence"> & {
  networks?: string[];
  thinLiquidity?: boolean;
};

/** Everything a compact view leaves out, for its title. */
export function ortDetail(p: Detail): string {
  const lines = [
    `Signal: ${p.quadrantLabel ?? "n/a"}`,
    `Regime: ${p.trendDirection ? REGIME_TEXT[p.trendDirection] : "n/a"}`,
    `Momentum: ${
      p.scoreTrend
        ? `${p.scoreTrend}${p.scoreTrendChange !== null ? ` (${fmtTrendChange(p.scoreTrendChange)} over 14d)` : ""}`
        : "building (not enough history yet)"
    }`,
  ];
  if (p.networks?.length) lines.push(`Networks: ${p.networks.map(networkName).join(", ")}`);
  if (p.thinLiquidity) lines.push("Thin liquidity: deepest pool is below a usable size");
  if (p.confidence === "low") lines.push("Low confidence: limited data behind this score");
  return lines.join("\n");
}
