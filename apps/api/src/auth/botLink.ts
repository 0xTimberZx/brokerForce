// Sign-in through the bot (spec 022, Phase 1 follow-up). The visitor opens a
// chat with the bot from /login; the bot checks group membership and replies
// with a short-lived signed link that sets the session cookie. Nothing is
// stored: the link carries its own signed payload.
import { createHmac, timingSafeEqual } from "node:crypto";
import { safeNext } from "./next.js";

/** How long a sign-in link from the bot stays valid. */
export const LINK_TTL_SECONDS = 5 * 60;

export interface LinkPayload {
  tgId: number;
  name: string;
  next: string;
  /** Expiry, seconds. */
  exp: number;
}

// The purpose prefix keeps a link token from ever validating as a session
// cookie (or the reverse), though both are signed with SESSION_SECRET.
function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`bf-link:${body}`).digest("base64url");
}

export function encodeLink(payload: LinkPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function decodeLink(token: string | undefined, secret: string, nowSeconds: number): LinkPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(token.slice(dot + 1));
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let p: LinkPayload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p?.tgId !== "number" || typeof p.name !== "string" || typeof p.exp !== "number") return null;
  if (nowSeconds > p.exp) return null;
  return { ...p, next: safeNext(typeof p.next === "string" ? p.next : "/") };
}

/**
 * The secret Telegram sends back in X-Telegram-Bot-Api-Secret-Token on every
 * webhook call, derived from the bot token so no extra secret has to be set
 * up: the setWebhook workflow computes the same value from the same token.
 *   printf 'bf-webhook' | openssl dgst -sha256 -hmac "$TOKEN"
 */
export function webhookSecret(botToken: string): string {
  return createHmac("sha256", botToken).update("bf-webhook").digest("hex");
}

export function isWebhookSecret(header: unknown, botToken: string): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(webhookSecret(botToken));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The /start parameter /login puts in the t.me link: "login", or
 * "l_" + base64url(next) when the destination fits Telegram's 64-character
 * limit. Anything else means "no particular destination".
 */
export function startParamFor(next: string): string {
  const target = safeNext(next);
  if (target === "/") return "login";
  const param = `l_${Buffer.from(target).toString("base64url")}`;
  return param.length <= 64 ? param : "login";
}

export function nextFromStartParam(param: string | undefined): string {
  if (!param?.startsWith("l_")) return "/";
  try {
    return safeNext(Buffer.from(param.slice(2), "base64url").toString("utf8"));
  } catch {
    return "/";
  }
}

/** The `/start <param>` command in a message, or null if it isn't one. */
export function parseStart(text: unknown): { param?: string } | null {
  if (typeof text !== "string") return null;
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!m) return null;
  return m[1] ? { param: m[1] } : {};
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  button: { text: string; url: string } | undefined,
  fetchImpl: typeof fetch
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
  if (button) body.reply_markup = { inline_keyboard: [[{ text: button.text, url: button.url }]] };
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { description?: string } | null;
    throw new Error(`sendMessage answered ${res.status}: ${detail?.description ?? ""}`);
  }
}
