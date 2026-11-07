/** Where to send someone after sign-in: a path on this site only, never
 * /login itself. Mirrors apps/web/src/auth/session.ts's safeNext. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) return "/";
  return next;
}
