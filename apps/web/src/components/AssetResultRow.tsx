import type { AssetSearchResult } from "@brokerforce/types";

interface AssetResultRowProps {
  asset: AssetSearchResult;
  onSelect: (symbol: string) => void;
}

// Asset-class label styling -- desaturated, informational, never competing
// with the amber ORT signal.
const CLASS_LABEL: Record<AssetSearchResult["class"], string> = {
  "blue-chip": "Blue chip",
  stable: "Stable",
  "growth-exotic": "Growth",
  degen: "Degen",
  commodity: "Gold",
};

/**
 * One asset result. Selecting it leads to the pair-this-with step (spec2.md:
 * a single-asset selection must not dead-end), so the whole row is a button.
 */
export function AssetResultRow({ asset, onSelect }: AssetResultRowProps) {
  return (
    <button
      onClick={() => onSelect(asset.symbol)}
      className="w-full flex items-center gap-3 py-2.5 text-left group"
    >
      <span className="font-mono text-sm text-ink w-16">{asset.symbol}</span>
      <span className="font-body text-sm text-ink-muted group-hover:text-ink truncate">
        {asset.name ?? "—"}
      </span>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-ink-muted border border-line px-2 py-0.5">
        {CLASS_LABEL[asset.class]}
      </span>
    </button>
  );
}
