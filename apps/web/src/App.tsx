// Routing arrived exactly when this file's old comment said it should:
// "add routing when there's a second page to route to, not before." With
// 001 Dashboard joining 003 Pair Analysis and 005 Pool Explorer, the app
// now has three destinations and URLs are the navigation contract:
//
//   /                            -> 001 Dashboard (the landing point)
//   /search                      -> 002 Search
//   /watchlist                   -> 007 Watchlists
//   /pairs/:assetA/:assetB       -> 003 Pair Analysis
//   /pairs/:assetA/:assetB/pools -> 005 Pool Explorer (pair context comes
//                                   from the URL, per spec5.md's "navigating
//                                   from 003 preserves pair context")

import { BrowserRouter, Routes, Route, Link, Navigate, useParams } from "react-router-dom";
import { DashboardPage } from "./pages/Dashboard";
import { SearchPage } from "./pages/Search";
import { WatchlistPage } from "./pages/Watchlist";
import { PairAnalysisPage } from "./pages/PairAnalysis";
import { PoolExplorerPage } from "./pages/PoolExplorer";
import { SiteFooter } from "./components/SiteFooter";

function PoolExplorerRoute() {
  const { assetA = "", assetB = "" } = useParams();
  return <PoolExplorerPage assetA={assetA.toUpperCase()} assetB={assetB.toUpperCase()} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg-deep flex flex-col">
        <nav className="border-b border-line">
          <div className="max-w-5xl mx-auto px-6 md:px-10 py-3 flex items-center gap-6">
            <Link to="/" className="font-display text-sm text-ink">
              BrokerForce
            </Link>
            <Link to="/" className="font-body text-xs text-ink-muted hover:text-ink">
              Dashboard
            </Link>
            <Link to="/watchlist" className="font-body text-xs text-ink-muted hover:text-ink">
              Watchlist
            </Link>
            <Link to="/search" className="font-body text-xs text-ink-muted hover:text-ink">
              Search
            </Link>
          </div>
        </nav>
        <main className="p-6 md:p-10 flex-1">
          <div className="max-w-5xl mx-auto">
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/watchlist" element={<WatchlistPage />} />
              <Route path="/pairs/:assetA/:assetB" element={<PairAnalysisPage />} />
              <Route path="/pairs/:assetA/:assetB/pools" element={<PoolExplorerRoute />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
        <SiteFooter />
      </div>
    </BrowserRouter>
  );
}
