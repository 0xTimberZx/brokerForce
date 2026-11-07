// Client side of the member gate (spec 022, Phase 1). The session itself is
// an HttpOnly cookie the browser sends on its own; this module only asks the
// API who's signed in and steers signed-out visitors to /login.

const API_URL = import.meta.env.VITE_API_URL ?? "/api";

export type TelegramUser = Record<string, string | number> & { id: number; hash: string; auth_date: number };

/** `next` must be a path on this site, so the login can't send anyone elsewhere.
 * Anything else, and /login itself, falls back to the dashboard. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) return "/";
  return next;
}

export function loginPath(next: string): string {
  const target = safeNext(next);
  return target === "/" ? "/login" : `/login?next=${encodeURIComponent(target)}`;
}

/** Sends a signed-out visitor to /login, keeping where they were headed. */
export function redirectToLogin(): void {
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname === "/login") return;
  window.location.assign(loginPath(here));
}

/**
 * fetch for data routes: a 401 means the session ended (expired, or the
 * person left the group), so go to /login instead of rendering an error.
 * Every other status is the caller's to handle, as before.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: "same-origin", ...init });
  if (res.status === 401) redirectToLogin();
  return res;
}

export type MeResult =
  | { state: "member"; name: string }
  | { state: "signed_out" }
  | { state: "closed"; reason: string }
  | { state: "error" };

export async function fetchMe(): Promise<MeResult> {
  try {
    const res = await fetch(`${API_URL}/auth/me`, { credentials: "same-origin" });
    if (res.ok) return { state: "member", name: ((await res.json()) as { name: string }).name };
    if (res.status === 401) return { state: "signed_out" };
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      return { state: "closed", reason: body.reason ?? "closed" };
    }
    return { state: "error" };
  } catch {
    return { state: "error" };
  }
}

export async function fetchAuthConfig(): Promise<{ botUsername: string | null; devBypass: boolean } | null> {
  try {
    const res = await fetch(`${API_URL}/auth/config`);
    return res.ok ? ((await res.json()) as { botUsername: string | null; devBypass: boolean }) : null;
  } catch {
    return null;
  }
}

export type SignInResult = { ok: true; name: string } | { ok: false; reason: "not_member" | "invalid" | "telegram_unavailable" | "error" };

export async function signInWithTelegram(user: TelegramUser): Promise<SignInResult> {
  try {
    const res = await fetch(`${API_URL}/auth/telegram`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(user),
    });
    const body = (await res.json().catch(() => ({}))) as { name?: string; reason?: string };
    if (res.ok) return { ok: true, name: body.name ?? "" };
    if (body.reason === "not_member" || body.reason === "invalid" || body.reason === "telegram_unavailable") {
      return { ok: false, reason: body.reason };
    }
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function signOut(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}
