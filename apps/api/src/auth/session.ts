// The bf_session cookie (spec 022, Phase 1): a signed payload, nothing stored
// on the server. Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "bf_session";

export interface SessionPayload {
  tgId: number;
  name: string;
  /** Issued at, seconds. The session ends `ttlSeconds` after this. */
  iat: number;
  /** When membership was last confirmed with Telegram, seconds. */
  memberCheckedAt: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function encodeSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** The payload if the signature checks out and the session hasn't expired; otherwise null. */
export function decodeSession(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
  ttlSeconds: number
): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(token.slice(dot + 1));
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload?.tgId !== "number" ||
    typeof payload.iat !== "number" ||
    typeof payload.memberCheckedAt !== "number" ||
    typeof payload.name !== "string"
  ) {
    return null;
  }
  if (nowSeconds - payload.iat > ttlSeconds || payload.iat > nowSeconds + 60) return null;
  return payload;
}

/** Reads one cookie from a Cookie header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
