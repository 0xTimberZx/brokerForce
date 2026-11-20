import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ORTPreviewChip } from "./ORTPreviewChip";
import { timeAgo } from "./timeAgo";
import type { RecentlyViewedPair } from "../store/recentlyViewedStore";

/**
 * spec1.md's Recently Viewed: quick re-entry into 003 Pair Analysis.
 * Contents come from the caller (the local-storage recentlyViewedStore);
 * current scores are hydrated live via ORTPreviewChip -- this list never
 * stores scores itself, per the spec's no-snapshot decision. Each row says
 * how long ago you last viewed the pair, refreshed every minute.
 */
export function RecentlyViewedList({ pairs }: { pairs: RecentlyViewedPair[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="border border-line bg-bg-panel p-5">
      <h2 className="font-display text-sm text-ink">Recently viewed</h2>
      <ul className="mt-3 divide-y divide-line">
        {pairs.map((p) => {
          const age = timeAgo(p.viewedAt, now);
          return (
            <li key={p.pairId} className="flex items-center justify-between gap-4 py-2.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <Link
                  to={`/pairs/${p.assetA}/${p.assetB}`}
                  className="font-body text-sm text-ink hover:underline underline-offset-4"
                >
                  {p.assetA}/{p.assetB}
                </Link>
                {age && (
                  <time
                    dateTime={p.viewedAt}
                    title={`Last viewed ${new Date(p.viewedAt).toLocaleString()}`}
                    className="font-mono text-xs text-ink-muted whitespace-nowrap"
                  >
                    {age}
                  </time>
                )}
              </div>
              <ORTPreviewChip pairId={p.pairId} window={90} compact />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
