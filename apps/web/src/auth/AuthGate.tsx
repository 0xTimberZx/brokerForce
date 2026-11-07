// Wraps every route except /login (spec 022, Phase 1). With no session the
// visitor goes to /login?next=<this path + query>, so a deep link opened while
// signed out lands back on the same view after signing in.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { fetchMe, loginPath, type MeResult } from "./session";

const MemberContext = createContext<string | null>(null);

/** The signed-in member's display name, inside the gate. */
export function useMemberName(): string | null {
  return useContext(MemberContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [me, setMe] = useState<MeResult | null>(null);

  // Checked once per page load; later expiry is caught by apiFetch's 401
  // handling, so navigating between views doesn't re-ask the API.
  useEffect(() => {
    let cancelled = false;
    fetchMe().then((r) => {
      if (!cancelled) setMe(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me) return <p className="font-body text-xs text-ink-muted">Loading…</p>;
  if (me.state === "member") return <MemberContext.Provider value={me.name}>{children}</MemberContext.Provider>;
  if (me.state === "error") {
    return (
      <p className="font-body text-sm text-ink">
        The terminal couldn't be reached. Check your connection and reload the page.
      </p>
    );
  }
  return <Navigate to={loginPath(location.pathname + location.search)} replace />;
}
