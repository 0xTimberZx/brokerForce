import { describe, it, expect } from "vitest";
import {
  dataCheckString,
  getChatMember,
  isAllowedMember,
  isGenuineLogin,
  isRecentLogin,
  TelegramUnavailableError,
} from "./telegram.js";

// Throwaway token. The expected hash was computed outside this code with
// openssl, so the test doesn't just compare the implementation with itself:
//   key=$(printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $2}')
//   printf 'auth_date=1794000000\nfirst_name=Ada\nid=42\nusername=ada' \
//     | openssl dgst -sha256 -mac HMAC -macopt hexkey:$key
const TOKEN = "123456:TEST-throwaway-token";
const VECTOR = {
  id: 42,
  first_name: "Ada",
  username: "ada",
  auth_date: 1794000000,
  hash: "4fafae7665fe63a4c5dd43630ae004b8c317b084a0adb0cea8afc78a219e112f",
};

describe("Telegram login verification", () => {
  it("builds the data-check string sorted by key, without hash", () => {
    expect(dataCheckString(VECTOR)).toBe("auth_date=1794000000\nfirst_name=Ada\nid=42\nusername=ada");
  });

  it("accepts the known-good vector", () => {
    expect(isGenuineLogin(VECTOR, TOKEN)).toBe(true);
  });

  it("accepts the same fields in any order", () => {
    const reordered = { hash: VECTOR.hash, username: "ada", auth_date: 1794000000, id: 42, first_name: "Ada" };
    expect(isGenuineLogin(reordered, TOKEN)).toBe(true);
  });

  it("rejects a tampered field, an added field, a wrong token and a malformed hash", () => {
    expect(isGenuineLogin({ ...VECTOR, id: 43 }, TOKEN)).toBe(false);
    expect(isGenuineLogin({ ...VECTOR, last_name: "Lovelace" }, TOKEN)).toBe(false);
    expect(isGenuineLogin(VECTOR, "654321:other-token")).toBe(false);
    expect(isGenuineLogin({ ...VECTOR, hash: "abc" }, TOKEN)).toBe(false);
    expect(isGenuineLogin({ ...VECTOR, hash: undefined as unknown as string }, TOKEN)).toBe(false);
  });

  it("refuses a login more than an hour old, or from the future", () => {
    const t = 1794000000;
    expect(isRecentLogin(t, t + 60)).toBe(true);
    expect(isRecentLogin(t, t + 3600)).toBe(true);
    expect(isRecentLogin(t, t + 3601)).toBe(false);
    expect(isRecentLogin(t + 600, t)).toBe(false);
    expect(isRecentLogin("not a number", t)).toBe(false);
  });
});

describe("membership status", () => {
  it("maps every getChatMember status", () => {
    expect(isAllowedMember({ status: "creator" })).toBe(true);
    expect(isAllowedMember({ status: "administrator" })).toBe(true);
    expect(isAllowedMember({ status: "member" })).toBe(true);
    expect(isAllowedMember({ status: "restricted", is_member: true })).toBe(true);
    expect(isAllowedMember({ status: "restricted", is_member: false })).toBe(false);
    expect(isAllowedMember({ status: "restricted" })).toBe(false);
    expect(isAllowedMember({ status: "left" })).toBe(false);
    expect(isAllowedMember({ status: "kicked" })).toBe(false);
    expect(isAllowedMember({ status: "something_new" })).toBe(false);
  });

  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the member from Telegram's answer", async () => {
    const m = await getChatMember(TOKEN, "-100123", 42, reply(200, { ok: true, result: { status: "member" } }));
    expect(m.status).toBe("member");
  });

  it("treats a 400 (user not in chat) as not a member", async () => {
    const m = await getChatMember(TOKEN, "-100123", 42, reply(400, { ok: false, description: "Bad Request: user not found" }));
    expect(isAllowedMember(m)).toBe(false);
  });

  it("reports outages and misconfiguration as 'couldn't check', not 'not a member'", async () => {
    await expect(getChatMember(TOKEN, "-100123", 42, reply(502, {}))).rejects.toBeInstanceOf(TelegramUnavailableError);
    await expect(
      getChatMember(TOKEN, "-100123", 42, reply(403, { ok: false, description: "Forbidden: bot is not a member" }))
    ).rejects.toBeInstanceOf(TelegramUnavailableError);
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(getChatMember(TOKEN, "-100123", 42, down)).rejects.toBeInstanceOf(TelegramUnavailableError);
  });
});
