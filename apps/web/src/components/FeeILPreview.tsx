import type { PairMetrics } from "@brokerforce/types";

interface FeeILPreviewProps {
  metrics: PairMetrics | null;
}

export function FeeILPreview({ metrics }: FeeILPreviewProps) {
  const il = metrics?.ilEstimate ?? null;

  return (
    <div className="border border-line bg-bg-panel p-4">
      <h3 className="font-display text-sm text-ink mb-3">Fee &amp; IL preview</h3>

      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Impermanent loss (est.)</div>
          <div className="font-mono text-lg text-ink">{il !== null ? `${(il * 100).toFixed(2)}%` : "—"}</div>
        </div>
        <div>
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Fee opportunity</div>
          <div className="font-mono text-sm text-ink-muted italic">pending pool data*</div>
        </div>
      </div>

      {/* Disabled, not a broken/missing link -- 006 Backtester doesn't exist
          as a real route yet (apps/web has no router, no /backtest page).
          A button that looks clickable but goes nowhere would be worse than
          one that's honestly disabled with a reason. */}
      <button
        disabled
        title="006 Backtester isn't built yet"
        className="w-full font-body text-sm px-4 py-2 border border-line text-ink-muted
                   cursor-not-allowed opacity-60"
      >
        Run full backtest — coming soon
      </button>

      <p className="font-body text-[11px] text-ink-muted mt-2">
        IL estimate is the real, textbook constant-product-AMM formula — a single end-of-window point estimate,
        not a day-by-day series. * Fee opportunity needs pool fee-tier and volume data that isn't ingested yet.
      </p>
    </div>
  );
}
