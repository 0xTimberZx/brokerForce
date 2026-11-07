// Telegram Login verification and the group-membership check (spec 022,
// Phase 1). Pure functions except getChatMember, which takes its fetch as a
// parameter so tests never reach Telegram.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** What the Login Widget hands the page, posted as-is to POST /auth/telegram. */
export type TelegramLoginData = Record<string, string | number> & {
  id: number | string;
  auth_date: number | string;
  hash: string;
};

/** A login older than this is refused, so a captured one can't be replayed later. */
export const MAX_LOGIN_AGE_SECONDS = 60 * 60;

/** Every field except `hash`, as `key=value`, sorted by key, joined with "\n". */
export function dataCheckString(data: Record<string, unknown>): string {
  return Object.keys(data)
    .filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${String(data[k])}`)
    .join("\n");
}

/** HMAC-SHA256 of the data-check string, keyed with SHA256(bot token), in hex. */
export function loginHash(data: Record<string, unknown>, botToken: string): string {
  const key = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", key).update(dataCheckString(data)).digest("hex");
}

export function isGenuineLogin(data: Record<string, unknown>, botToken: string): boolean {
  if (typeof data.hash !== "string" || !/^[0-9a-f]{64}$/.test(data.hash)) return false;
  const expected = Buffer.from(loginHash(data, botToken), "hex");
  const received = Buffer.from(data.hash, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function isRecentLogin(authDate: unknown, nowSeconds: number): boolean {
  const t = Number(authDate);
  if (!Number.isFinite(t)) return false;
  // A little slack for a clock running ahead; anything further in the future is bogus.
  return t <= nowSeconds + 60 && nowSeconds - t <= MAX_LOGIN_AGE_SECONDS;
}

/** The slice of Telegram's ChatMember this check reads. */
export interface ChatMember {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked" | string;
  is_member?: boolean;
}

/** creator, administrator and member get in; restricted only while still a
 * member; left, kicked and anything unknown are refused. */
export function isAllowedMember(member: ChatMember): boolean {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return member.is_member === true;
    default:
      return false;
  }
}

export class TelegramUnavailableError extends Error {}

/**
 * Asks Telegram whether `userId` is in the group. Returns the member, or a
 * synthetic `left` when Telegram says the user isn't a participant (a 400
 * such as "user not found"). Network failures and 5xx answers throw
 * TelegramUnavailableError, so callers can tell "not a member" from
 * "couldn't check".
 */
export async function getChatMember(
  botToken: string,
  groupId: string,
  userId: number | string,
  fetchImpl: typeof fetch = fetch
): Promise<ChatMember> {
  const url =
    `https://api.telegram.org/bot${botToken}/getChatMember` +
    `?chat_id=${encodeURIComponent(groupId)}&user_id=${encodeURIComponent(String(userId))}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new TelegramUnavailableError(`getChatMember request failed: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: true; result: ChatMember }
    | { ok: false; error_code?: number; description?: string }
    | null;
  if (body?.ok) return body.result;
  if (res.status === 400) return { status: "left" };
  // 401/403/404 mean the bot token or group is misconfigured, not that this
  // person is out: report it as "couldn't check" so it shows up in the logs.
  throw new TelegramUnavailableError(
    `getChatMember answered ${res.status}: ${body && !body.ok ? body.description ?? "" : "unreadable body"}`
  );
}
