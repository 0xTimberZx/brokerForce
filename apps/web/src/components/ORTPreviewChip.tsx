import { useEffect, useState } from "react";
import type { CanonicalWindow, OrtScore } from "@brokerforce/types";
import { fetchOrtScoreSafe } from "../api/client";
import { OrtTrendTags } from "./OrtTrendTags";
import { MOMENTUM, SIGNAL_MARK, ortDetail } from "./ortMarks";

interface ORTPreviewChipProps {
  pairId: string;
  window: CanonicalWindow;
  /** Mark, arrow and score only, with the rest in the title. For lists such
   * as Recently viewed; the pair page keeps the full chip. */
  compact?: boolean;
}

/**
 * 004 ORT Engine exists now, but most pairs still won't have a score: only
 * active-tier pairs get one (ORT.md §5), and no pair can be promoted to
 * active without real pool data that doesn't exist yet
 * (apps/pair-engine/README.md). "ORT pending" below means exactly that --
 * not "this feature isn't built" anymore, but "this specific pair hasn't
 * cleared the activity bar yet" -- a real, expected, and probably common
 * state for a while, not an error.
 */
export function ORTPreviewChip({ pairId, window, compact = false }: ORTPreviewChipProps) {
  const [ort, setOrt] = useState<OrtScore | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchOrtScoreSafe(pairId, window).then((result) => {
      setOrt(result);
      setLoading(false);
    });
  }, [pairId, window]);

  if (compact && (loading || !ort)) {
    return (
      <span
        className="font-mono text-xs text-ink-muted"
        title={loading ? undefined : "No ORT score yet: this pair hasn't reached the active tier"}
      >
        {loading ? "—" : "pending"}
      </span>
    );
  }

  if (loading) {
    return (
      <div className="border border-line px-3 py-1.5 font-mono text-sm text-ink-muted">
        ORT —
      </div>
    );
  }

  if (!ort) {
    return (
      <div
        className="border border-line px-3 py-1.5 flex items-center gap-2 font-mono text-sm text-ink-muted"
        title="No ORT score yet -- this pair hasn't reached active tier (needs real pool TVL/volume data, which isn't ingested yet)"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" />
        ORT pending
      </div>
    );
  }

  if (compact) {
    const mark = ort.quadrantLabel ? SIGNAL_MARK[ort.quadrantLabel] : null;
    const momentum = ort.scoreTrend ? MOMENTUM[ort.scoreTrend] : null;
    return (
      <div className="flex items-center gap-3 font-mono text-sm" title={ortDetail(ort)}>
        <span className={`text-[13px] leading-none ${mark?.cls ?? "text-ink-muted"}`} aria-label={ort.quadrantLabel ?? undefined}>
          {mark?.glyph ?? "·"}
        </span>
        <span className={momentum?.cls ?? "text-ink-muted"} aria-hidden>
          {momentum?.glyph ?? "·"}
        </span>
        <span className="text-signal font-medium tabular-nums w-6 text-right">{ort.score.toFixed(0)}</span>
      </div>
    );
  }

  return (
    <div className="border border-signal px-3 py-1.5 flex items-center gap-2 font-mono text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-signal" />
      <span className="text-ink font-medium">{ort.score.toFixed(0)}</span>
      {ort.quadrantLabel && <span className="text-ink-muted text-xs uppercase">{ort.quadrantLabel}</span>}
      {/* Spec 020: both trend reads, labelled distinctly -- Regime (quadrant,
          30d vs 90d) and Momentum (score over the last 14d). */}
      <OrtTrendTags
        trendDirection={ort.trendDirection}
        scoreTrend={ort.scoreTrend}
        scoreTrendChange={ort.scoreTrendChange}
      />
      {ort.confidence === "low" && <span className="text-ink-muted text-xs italic">low confidence</span>}
    </div>
  );
}
