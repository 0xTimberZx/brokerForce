// /login (spec 022, Phase 1): the Telegram Login Widget. The terminal is for
// members of the BrokerForce Telegram group; the API checks membership with
// the group's bot, and on success the visitor returns to `next`, which is how
// a deep link from a group post survives signing in.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchAuthConfig, fetchMe, loginPath, safeNext, signInWithTelegram, type TelegramUser } from "../auth/session";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; botUsername: string }
  | { kind: "signing_in" }
  | { kind: "not_member" }
  | { kind: "invalid" }
  | { kind: "unavailable" }
  | { kind: "closed" };

/** The fields Telegram signs. Only these are sent on, so `next` (or anything
 * else in the URL) never ends up in the data the hash is checked against. */
const TELEGRAM_FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"];

function telegramFieldsFrom(params: URLSearchParams): TelegramUser | null {
  if (!params.get("hash") || !params.get("id") || !params.get("auth_date")) return null;
  const fields: Record<string, string> = {};
  for (const key of TELEGRAM_FIELDS) {
    const value = params.get(key);
    if (value !== null) fields[key] = value;
  }
  return fields as unknown as TelegramUser;
}


export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const widgetRef = useRef<HTMLDivElement>(null);

  // Telegram sends the visitor back here with the signed login fields in the
  // query string (the widget's redirect mode; see below). Read them once.
  const returned = telegramFieldsFrom(params);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (returned) {
        setStatus({ kind: "signing_in" });
        // Drop the login fields from the address bar either way, so a reload
        // or a shared URL never carries them.
        window.history.replaceState(null, "", loginPath(next));
        const result = await signInWithTelegram(returned);
        if (cancelled) return;
        if (result.ok) return navigate(next, { replace: true });
        if (result.reason === "not_member") return setStatus({ kind: "not_member" });
        if (result.reason === "telegram_unavailable") return setStatus({ kind: "unavailable" });
        return setStatus({ kind: "invalid" });
      }
      // Already signed in (or local dev bypass): go straight on.
      const me = await fetchMe();
      if (cancelled) return;
      if (me.state === "member") return navigate(next, { replace: true });
      if (me.state === "closed") return setStatus({ kind: "closed" });
      const cfg = await fetchAuthConfig();
      if (cancelled) return;
      if (!cfg?.botUsername) return setStatus({ kind: "closed" });
      setStatus({ kind: "ready", botUsername: cfg.botUsername });
    })();
    return () => {
      cancelled = true;
    };
    // `returned` comes from the URL, which this effect rewrites; it runs once per `next`.
  }, [navigate, next]);

  // Redirect mode, not the widget's JavaScript callback: the callback relies
  // on the Telegram popup talking back to this tab, which mobile browsers
  // (Brave, in-app browsers, anything that opens the popup as a new tab)
  // often break, so the login silently went nowhere. With data-auth-url,
  // Telegram navigates back to /login with the signed fields instead.
  const botUsername = status.kind === "ready" ? status.botUsername : null;
  useEffect(() => {
    const host = widgetRef.current;
    if (!botUsername || !host) return;
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-request-access", "false");
    script.setAttribute("data-auth-url", window.location.origin + loginPath(next));
    host.replaceChildren(script);
    return () => {
      host.replaceChildren();
    };
  }, [botUsername, next]);

  return (
    <section className="max-w-md mx-auto mt-10 border border-line bg-bg-panel p-6">
      <h1 className="font-display text-lg text-ink">Sign in</h1>
      <p className="font-body text-sm text-ink-muted mt-2">
        The terminal is open to members of the BrokerForce Telegram group. Sign in with Telegram to continue.
      </p>

      <div className="mt-6 min-h-[48px]">
        {status.kind === "loading" && <p className="font-body text-xs text-ink-muted">Loading…</p>}
        {status.kind === "signing_in" && <p className="font-body text-xs text-ink-muted">Checking membership…</p>}
        <div ref={widgetRef} hidden={status.kind !== "ready"} />
      </div>

      {status.kind === "not_member" && (
        <Notice>
          That Telegram account isn't in the BrokerForce group. The terminal is for group members only; ask an admin for
          an invite, then sign in again.
        </Notice>
      )}
      {status.kind === "invalid" && (
        <Notice>
          The sign-in couldn't be verified, or it took too long. Reload the page and try again.
        </Notice>
      )}
      {status.kind === "unavailable" && (
        <Notice>Telegram couldn't be reached to confirm membership. Try again in a few minutes.</Notice>
      )}
      {status.kind === "closed" && (
        <Notice>Sign-in isn't available yet. The terminal opens to group members once it's live.</Notice>
      )}
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="font-body text-sm text-ink mt-4 border-t border-line pt-4">{children}</p>;
}
