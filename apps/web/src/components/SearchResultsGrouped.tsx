import type { SearchResponse } from "@brokerforce/types";
import { AssetResultRow } from "./AssetResultRow";
import { PairResultRow } from "./PairResultRow";
import { NoResultsState } from "./NoResultsState";

interface SearchResultsGroupedProps {
  query: string;
  results: SearchResponse["results"];
  onSelectAsset: (symbol: string) => void;
}

/**
 * Sectioned results (Assets / Pairs), per spec2.md -- so a user scans by kind
 * rather than a flat undifferentiated list. Pools is a reserved-but-empty
 * group server-side, so it isn't rendered. A truly empty result set shows the
 * no-results guidance instead of blank sections.
 */
export function SearchResultsGrouped({ query, results, onSelectAsset }: SearchResultsGroupedProps) {
  const { assets, pairs } = results;
  if (assets.length === 0 && pairs.length === 0) {
    return <NoResultsState query={query} />;
  }

  return (
    <div className="space-y-4">
      {pairs.length > 0 && (
        <section className="border border-line bg-bg-panel p-5">
          <h2 className="font-display text-sm text-ink">Pairs</h2>
          <div className="mt-2 divide-y divide-line">
            {pairs.map((p) => (
              <PairResultRow key={p.pairId} pair={p} />
            ))}
          </div>
        </section>
      )}

      {assets.length > 0 && (
        <section className="border border-line bg-bg-panel p-5">
          <h2 className="font-display text-sm text-ink">Assets</h2>
          <div className="mt-2 divide-y divide-line">
            {assets.map((a) => (
              <AssetResultRow key={a.symbol} asset={a} onSelect={onSelectAsset} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
