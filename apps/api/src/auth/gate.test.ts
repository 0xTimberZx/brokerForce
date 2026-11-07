import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { createGate, loadAuthMode, type AuthMode } from "./gate.js";
import { loginHash } from "./telegram.js";
import { encodeSession } from "./session.js";
import { catchAsyncErrors, errorHandler } from "../http/asyncErrors.js";

const TOKEN = "123456:TEST-throwaway-token";
const SECRET = "x".repeat(40);
const MODE: AuthMode = {
  kind: "gate",
  config: { botToken: TOKEN, botUsername: "bf_bot", groupId: "-100123", sessionSecret: SECRET, sessionTtlSeconds: 7 * 86400 },
};

let clock = 1794000000;
let telegramStatus: string | "down" = "member";
let telegramCalls = 0;
const fakeTelegram = (async () => {
  telegramCalls++;
  if (telegramStatus === "down") return new Response("{}", { status: 502 });
  return new Response(JSON.stringify({ ok: true, result: { status: telegramStatus } }), { status: 200 });
}) as unknown as typeof fetch;

async function serve(mode: AuthMode = MODE) {
  const gate = createGate(mode, { fetch: fakeTelegram, now: () => clock });
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/auth", catchAsyncErrors(gate.authRouter));
  app.use(gate.requireMember);
  app.get("/pairs/ort", (_req, res) => res.json({ data: "secret" }));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function login(fields: Record<string, string | number> = {}) {
  const data: Record<string, string | number> = { id: 42, first_name: "Ada", auth_date: clock, ...fields };
  return { ...data, hash: loginHash(data, TOKEN) };
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

beforeEach(() => {
  clock = 1794000000;
  telegramStatus = "member";
  telegramCalls = 0;
});

describe("member gate", () => {
  it("keeps data routes closed without a session, while /health and /auth answer", async () => {
    const { base, close } = await serve();
    try {
      expect((await fetch(`${base}/pairs/ort`)).status).toBe(401);
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect(await (await fetch(`${base}/auth/config`)).json()).toEqual({ botUsername: "bf_bot", devBypass: false });
      expect((await fetch(`${base}/auth/me`)).status).toBe(401);
    } finally {
      close();
    }
  });

  it("signs a member in and lets the cookie through", async () => {
    const { base, close } = await serve();
    try {
      const res = await fetch(`${base}/auth/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(login()),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: "Ada" });
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Secure/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      const cookie = cookieOf(res);
      expect((await fetch(`${base}/pairs/ort`, { headers: { cookie } })).status).toBe(200);
      expect(await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json()).toEqual({ name: "Ada" });
    } finally {
      close();
    }
  });

  it("refuses a non-member, a forged login and a stale login", async () => {
    const { base, close } = await serve();
    const post = (body: unknown) =>
      fetch(`${base}/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post({ ...login(), id: 43 })).status).toBe(401);
      expect((await post(login({ auth_date: clock - 3601 }))).status).toBe(401);
      telegramStatus = "left";
      const res = await post(login());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ reason: "not_member" });
      telegramStatus = "down";
      expect((await post(login())).status).toBe(503);
    } finally {
      close();
    }
  });

  it("refuses a forged or expired cookie", async () => {
    const { base, close } = await serve();
    try {
      const forged = encodeSession({ tgId: 42, name: "Ada", iat: clock, memberCheckedAt: clock }, "y".repeat(40));
      expect((await fetch(`${base}/pairs/ort`, { headers: { cookie: `bf_session=${forged}` } })).status).toBe(401);
      const old = encodeSession({ tgId: 42, name: "Ada", iat: clock - 8 * 86400, memberCheckedAt: clock }, SECRET);
      expect((await fetch(`${base}/pairs/ort`, { headers: { cookie: `bf_session=${old}` } })).status).toBe(401);
    } finally {
      close();
    }
  });

  it("re-checks membership after an hour and locks out someone who left", async () => {
    const { base, close } = await serve();
    try {
      const cookie = `bf_session=${encodeSession({ tgId: 42, name: "Ada", iat: clock, memberCheckedAt: clock }, SECRET)}`;
      clock += 30 * 60;
      expect((await fetch(`${base}/pairs/ort`, { headers: { cookie } })).status).toBe(200);
      expect(telegramCalls).toBe(0);

      clock += 31 * 60; // now past the hour
      const stillIn = await fetch(`${base}/pairs/ort`, { headers: { cookie } });
      expect(stillIn.status).toBe(200);
      expect(telegramCalls).toBe(1);
      const refreshed = cookieOf(stillIn);
      expect(refreshed).toMatch(/^bf_session=.+/);

      telegramStatus = "left";
      clock += 61 * 60;
      const out = await fetch(`${base}/pairs/ort`, { headers: { cookie: refreshed } });
      expect(out.status).toBe(401);
      expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    } finally {
      close();
    }
  });

  it("rides out a Telegram outage for up to a day since the last check", async () => {
    const { base, close } = await serve();
    try {
      telegramStatus = "down";
      const cookie = `bf_session=${encodeSession({ tgId: 42, name: "Ada", iat: clock, memberCheckedAt: clock }, SECRET)}`;
      const errLog = console.error;
      console.error = () => {};
      try {
        clock += 2 * 3600;
        expect((await fetch(`${base}/pairs/ort`, { headers: { cookie } })).status).toBe(200);
        clock += 23 * 3600;
        expect((await fetch(`${base}/pairs/ort`, { headers: { cookie } })).status).toBe(503);
      } finally {
        console.error = errLog;
      }
    } finally {
      close();
    }
  });

  it("logout clears the cookie", async () => {
    const { base, close } = await serve();
    try {
      const res = await fetch(`${base}/auth/logout`, { method: "POST" });
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toMatch(/bf_session=;.*Max-Age=0/);
    } finally {
      close();
    }
  });

  it("fails closed when its secrets are missing", async () => {
    const errLog = console.error;
    console.error = () => {};
    const { base, close } = await serve(loadAuthMode({ NODE_ENV: "production" }));
    console.error = errLog;
    try {
      expect((await fetch(`${base}/pairs/ort`)).status).toBe(503);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      close();
    }
  });
});

describe("loadAuthMode", () => {
  const full = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_BOT_USERNAME: "@bf_bot",
    TELEGRAM_GROUP_ID: "-100123",
    SESSION_SECRET: SECRET,
  };

  it("refuses the dev bypass in production", () => {
    expect(() => loadAuthMode({ AUTH_DEV_BYPASS: "1", NODE_ENV: "production" })).toThrow(/refusing to start/);
    expect(() => loadAuthMode({ AUTH_DEV_BYPASS: "1", VERCEL_ENV: "preview" })).toThrow(/refusing to start/);
    expect(loadAuthMode({ AUTH_DEV_BYPASS: "1", NODE_ENV: "development" }).kind).toBe("bypass");
  });

  it("lists what's missing, including a short session secret", () => {
    const mode = loadAuthMode({ ...full, TELEGRAM_GROUP_ID: "", SESSION_SECRET: "short" });
    expect(mode).toEqual({ kind: "unconfigured", missing: ["TELEGRAM_GROUP_ID", "SESSION_SECRET (32+ characters)"] });
  });

  it("builds the gate config with a 7-day default session", () => {
    const mode = loadAuthMode(full);
    expect(mode.kind).toBe("gate");
    if (mode.kind === "gate") {
      expect(mode.config.botUsername).toBe("bf_bot");
      expect(mode.config.sessionTtlSeconds).toBe(7 * 86400);
    }
    const short = loadAuthMode({ ...full, SESSION_TTL_DAYS: "1" });
    if (short.kind === "gate") expect(short.config.sessionTtlSeconds).toBe(86400);
  });

  it("opens localhost only in bypass mode", async () => {
    const { base, close } = await serve({ kind: "bypass" });
    try {
      expect((await fetch(`${base}/pairs/ort`)).status).toBe(200); // 127.0.0.1
      // fetch won't override Host, so use node:http for the non-local case.
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`${base}/pairs/ort`, { headers: { host: "brokerforce.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(401);
    } finally {
      close();
    }
  });
});
