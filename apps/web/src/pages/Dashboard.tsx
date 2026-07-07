// 001 Dashboard -- the composition layer, per spec1.md: no new computation
// lives here, only data already produced by 003/004 plus the client-side
// recently-viewed store. Two spec sections are deliberately absent for now:
//
//   - Watchlist summary: 007 Watchlists (and its watchlistStore) isn't
//     built. spec1.md allows hiding the section for users without a
//     watchlist -- which is currently everyone -- so nothing is rendered
//     rather than a card teasing a feature that doesn't exist. Add the
//     WatchlistSummaryCard when 007 lands.
//   - QuickSearchBar: hands off to 002 Search, which isn't built. The
//     header uses PairSelector as the jump-to-pair entry point until then
//     (same reasoning as PairSelector's own header comment).

import { useNavigate } from "react-router-dom";
import { PairSelector } from "../components/PairSelector";
import { TopOpportunitiesPanel } from "../components/TopOpportunitiesPanel";
import { RecentlyViewedList } from "../components/RecentlyViewedList";
import { NewUserIntroPanel } from "../components/NewUserIntroPanel";
import { getRecent } from "../store/recentlyViewedStore";

export function DashboardPage() {
  const navigate = useNavigate();
  // Read once per render of the dashboard -- the store only changes when a
  // pair page records a view, which always involves navigating away.
  const recent = getRecent();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl text-ink">Dashboard</h1>
          <p className="font-body text-xs text-ink-muted">What's worth attention right now</p>
        </div>
        <PairSelector
          defaultAssetA=""
          defaultAssetB=""
          onSubmit={(a, b) => navigate(`/pairs/${a}/${b}`)}
        />
      </header>

      <div className="grid md:grid-cols-2 gap-4 items-start">
        <TopOpportunitiesPanel />
        {/* New-user state: intro replaces personal sections when there's no
            history, per spec1.md -- the page must feel populated either way. */}
        {recent.length > 0 ? <RecentlyViewedList pairs={recent} /> : <NewUserIntroPanel />}
      </div>
    </div>
  );
}
