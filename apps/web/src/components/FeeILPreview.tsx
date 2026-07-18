import { Link } from "react-router-dom";
import type { PairMetrics } from "@brokerforce/types";

interface FeeILPreviewProps {
  metrics: PairMetrics | null;
  // The pair symbols carry into the Backtester as pre-fill (spec6.md's 003
  // entry point) -- the reason this component now needs to know them.
  assetA: string;
  assetB: string;
}

export function FeeILPreview({ metrics, assetA, assetB }: FeeILPreviewProps) {
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

      {/* The old honestly-disabled button, finally enabled: 006 Backtester
          exists as a real route now. Pair context rides the query string. */}
      <Link
        to={`/backtest?assetA=${encodeURIComponent(assetA)}&assetB=${encodeURIComponent(assetB)}`}
        className="block w-full text-center font-body text-sm px-4 py-2 border border-signal text-signal
                   hover:bg-signal hover:text-bg-deep transition-colors"
      >
        Run full backtest →
      </Link>

      <p className="font-body text-[11px] text-ink-muted mt-2">
        IL estimate is the real, textbook constant-product-AMM formula — a single end-of-window point estimate,
        not a day-by-day series. * Fee opportunity needs pool fee-tier and volume data that isn't ingested yet.
      </p>
    </div>
  );
}
