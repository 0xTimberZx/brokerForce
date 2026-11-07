// Routing arrived exactly when this file's old comment said it should:
// "add routing when there's a second page to route to, not before." With
// 001 Dashboard joining 003 Pair Analysis and 005 Pool Explorer, the app
// now has three destinations and URLs are the navigation contract:
//
//   /                            -> 001 Dashboard (the landing point)
//   /search                      -> 002 Search
//   /watchlist                   -> 007 Watchlists
//   /backtest                    -> 006 Backtester (?assetA=&assetB=[&feeTier=]
//                                   carries pre-fill context from 003/005)
//   /pairs/:assetA/:assetB       -> 003 Pair Analysis
//   /pairs/:assetA/:assetB/pools -> 005 Pool Explorer (pair context comes
//                                   from the URL, per spec5.md's "navigating
//                                   from 003 preserves pair context")
//   /login                       -> 022 sign-in (Telegram Login); every other
//                                   route sits behind AuthGate

import { BrowserRouter, Routes, Route, Link, Navigate, Outlet, useParams, useNavigate } from "react-router-dom";
import { DashboardPage } from "./pages/Dashboard";
import { SearchPage } from "./pages/Search";
import { WatchlistPage } from "./pages/Watchlist";
import { PairAnalysisPage } from "./pages/PairAnalysis";
import { PoolExplorerPage } from "./pages/PoolExplorer";
import { BacktestPage } from "./pages/Backtest";
import { AssetDetailPage } from "./pages/AssetDetail";
import { SiteFooter } from "./components/SiteFooter";
import { LoginPage } from "./pages/Login";
import { AuthGate, useMemberName } from "./auth/AuthGate";
import { signOut } from "./auth/session";

function PoolExplorerRoute() {
  const { assetA = "", assetB = "" } = useParams();
  const navigate = useNavigate();
  const a = assetA.toUpperCase();
  const b = assetB.toUpperCase();
  return (
    <PoolExplorerPage
      assetA={a}
      assetB={b}
      // spec6.md's 005 entry point: pool-specific simulation, pre-filled with
      // that pool's fee tier -- carried via query params, no silent drop.
      onSimulatePool={(pool) =>
        navigate(
          `/backtest?assetA=${encodeURIComponent(a)}&assetB=${encodeURIComponent(b)}${
            pool.feeTier > 0 ? `&feeTier=${pool.feeTier}` : ""
          }`
        )
      }
    />
  );
}

function MemberMenu() {
  const name = useMemberName();
  return (
    <div className="ml-auto flex items-center gap-3 shrink-0">
      {/* The name can be long (Telegram display names often are), so it's
          hidden on a phone and truncated elsewhere; Sign out never moves. */}
      {name && (
        <span className="hidden md:inline font-body text-xs text-ink-muted max-w-[14rem] truncate" title={name}>
          {name}
        </span>
      )}
      <button
        type="button"
        className="font-body text-xs text-ink-muted hover:text-ink whitespace-nowrap"
        onClick={async () => {
          await signOut();
          window.location.assign("/login");
        }}
      >
        Sign out
      </button>
    </div>
  );
}

/** The terminal's chrome around every gated page. */
function TerminalLayout() {
  return (
    <AuthGate>
      {/* On a phone the links scroll sideways inside their own strip, so the
          member menu (and Sign out) always stays on screen. */}
      <nav className="border-b border-line">
        <div className="max-w-5xl mx-auto px-4 md:px-10 py-3 flex items-center gap-4">
          <Link to="/" className="font-display text-sm text-ink shrink-0">
            BrokerForce
          </Link>
          <div className="flex items-center gap-4 md:gap-6 min-w-0 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
            <Link to="/" className="font-body text-xs text-ink-muted hover:text-ink">
              Dashboard
            </Link>
            <Link to="/watchlist" className="font-body text-xs text-ink-muted hover:text-ink">
              Watchlist
            </Link>
            <Link to="/search" className="font-body text-xs text-ink-muted hover:text-ink">
              Search
            </Link>
            <Link to="/backtest" className="font-body text-xs text-ink-muted hover:text-ink">
              Backtester
            </Link>
          </div>
          <MemberMenu />
        </div>
      </nav>
      <main className="p-6 md:p-10 flex-1">
        <div className="max-w-5xl mx-auto">
          <Outlet />
        </div>
      </main>
    </AuthGate>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg-deep flex flex-col">
        <Routes>
          <Route
            path="/login"
            element={
              <main className="p-6 md:p-10 flex-1">
                <LoginPage />
              </main>
            }
          />
          <Route element={<TerminalLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/watchlist" element={<WatchlistPage />} />
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/assets/:symbol" element={<AssetDetailPage />} />
            <Route path="/pairs/:assetA/:assetB" element={<PairAnalysisPage />} />
            <Route path="/pairs/:assetA/:assetB/pools" element={<PoolExplorerRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <SiteFooter />
      </div>
    </BrowserRouter>
  );
}
