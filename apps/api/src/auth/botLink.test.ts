import { describe, it, expect } from "vitest";
import {
  decodeLink,
  encodeLink,
  isWebhookSecret,
  nextFromStartParam,
  parseStart,
  startParamFor,
  webhookSecret,
} from "./botLink.js";
import { decodeSession } from "./session.js";

const SECRET = "x".repeat(40);
const T = 1794000000;

describe("bot sign-in links", () => {
  it("round-trips and expires after five minutes", () => {
    const token = encodeLink({ tgId: 42, name: "Ada", next: "/pairs/ETH/XRP", exp: T + 300 }, SECRET);
    expect(decodeLink(token, SECRET, T)).toEqual({ tgId: 42, name: "Ada", next: "/pairs/ETH/XRP", exp: T + 300 });
    expect(decodeLink(token, SECRET, T + 301)).toBeNull();
  });

  it("refuses a forged link, and is never accepted as a session cookie", () => {
    const token = encodeLink({ tgId: 42, name: "Ada", next: "/", exp: T + 300 }, SECRET);
    expect(decodeLink(token, "y".repeat(40), T)).toBeNull();
    expect(decodeLink(token.replace(/^./, "A"), SECRET, T)).toBeNull();
    expect(decodeSession(token, SECRET, T, 7 * 86400)).toBeNull();
  });

  it("cleans an off-site destination inside a signed link", () => {
    const token = encodeLink({ tgId: 42, name: "Ada", next: "//evil.example", exp: T + 300 }, SECRET);
    expect(decodeLink(token, SECRET, T)?.next).toBe("/");
  });
});

describe("/start parameter", () => {
  it("carries the destination when it fits Telegram's 64 characters", () => {
    const param = startParamFor("/pairs/ETH/XRP?window=30");
    expect(param).toMatch(/^l_[A-Za-z0-9_-]+$/);
    expect(param.length).toBeLessThanOrEqual(64);
    expect(nextFromStartParam(param)).toBe("/pairs/ETH/XRP?window=30");
  });

  it("falls back to plain login for the dashboard, long paths and junk", () => {
    expect(startParamFor("/")).toBe("login");
    expect(startParamFor("/" + "a".repeat(80))).toBe("login");
    expect(nextFromStartParam("login")).toBe("/");
    expect(nextFromStartParam(undefined)).toBe("/");
    expect(nextFromStartParam(`l_${Buffer.from("https://evil.example").toString("base64url")}`)).toBe("/");
  });

  it("parses /start commands", () => {
    expect(parseStart("/start")).toEqual({});
    expect(parseStart("/start login")).toEqual({ param: "login" });
    expect(parseStart("/start@AskBFFbot l_abc")).toEqual({ param: "l_abc" });
    expect(parseStart("hello")).toBeNull();
    expect(parseStart("/help")).toBeNull();
    expect(parseStart(undefined)).toBeNull();
  });
});

describe("webhook secret", () => {
  it("matches the openssl derivation the setWebhook workflow uses", () => {
    // printf 'bf-webhook' | openssl dgst -sha256 -hmac '123456:TEST-throwaway-token'
    expect(webhookSecret("123456:TEST-throwaway-token")).toBe(WEBHOOK_VECTOR);
    expect(isWebhookSecret(WEBHOOK_VECTOR, "123456:TEST-throwaway-token")).toBe(true);
    expect(isWebhookSecret("nope", "123456:TEST-throwaway-token")).toBe(false);
    expect(isWebhookSecret(undefined, "123456:TEST-throwaway-token")).toBe(false);
  });
});

const WEBHOOK_VECTOR = "c77bb4befb712f93ea490587fee5fc577085bc9058129643ad1db8e95ce5f040";
