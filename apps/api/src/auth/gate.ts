// The member gate (spec 022, Phase 1): the /auth routes and the requireMember
// middleware that runs in front of every data route. app.ts mounts both;
// /health is registered before them and stays open.
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import {
  getChatMember,
  isAllowedMember,
  isGenuineLogin,
  isRecentLogin,
  TelegramUnavailableError,
} from "./telegram.js";
import {
  clearedSessionCookieHeader,
  decodeSession,
  encodeSession,
  readCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
  type SessionPayload,
} from "./session.js";

export interface GateConfig {
  botToken: string;
  botUsername: string;
  groupId: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
}

export type AuthMode =
  | { kind: "gate"; config: GateConfig }
  /** AUTH_DEV_BYPASS=1 outside production: localhost requests skip the gate. */
  | { kind: "bypass" }
  /** Secrets missing: fail closed, every data route answers 503. */
  | { kind: "unconfigured"; missing: string[] };

const DAY = 24 * 60 * 60;
/** Membership is re-confirmed with Telegram once the last check is older than this. */
export const MEMBER_RECHECK_SECONDS = 60 * 60;
/** If Telegram can't be reached, a member confirmed within this long ago keeps access. */
export const MEMBER_GRACE_SECONDS = DAY;
/** How long one getChatMember answer is reused within a function instance:
 * long enough to absorb a page's burst of parallel requests, short enough
 * not to stretch the hourly re-check. */
const MEMBER_CACHE_SECONDS = 60;

/** Reads the gate's settings from the environment. Throws if the dev bypass
 * is switched on in production, so a misconfigured deploy refuses to start
 * instead of opening the terminal. */
export function loadAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  if (env.AUTH_DEV_BYPASS === "1") {
    if (env.NODE_ENV === "production" || env.VERCEL_ENV) {
      throw new Error("AUTH_DEV_BYPASS is set in a production environment; refusing to start.");
    }
    return { kind: "bypass" };
  }
  const required = {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: env.TELEGRAM_BOT_USERNAME,
    TELEGRAM_GROUP_ID: env.TELEGRAM_GROUP_ID,
    SESSION_SECRET: env.SESSION_SECRET,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) missing.push("SESSION_SECRET (32+ characters)");
  if (missing.length) return { kind: "unconfigured", missing };
  const days = Number(env.SESSION_TTL_DAYS ?? 7);
  return {
    kind: "gate",
    config: {
      botToken: required.TELEGRAM_BOT_TOKEN!,
      botUsername: required.TELEGRAM_BOT_USERNAME!.replace(/^@/, ""),
      groupId: required.TELEGRAM_GROUP_ID!,
      sessionSecret: required.SESSION_SECRET!,
      sessionTtlSeconds: (Number.isFinite(days) && days > 0 ? days : 7) * DAY,
    },
  };
}

export interface GateDeps {
  fetch?: typeof fetch;
  /** Current time in seconds. */
  now?: () => number;
}

type SessionCheck =
  | { ok: true; session: SessionPayload }
  | { ok: false; status: 401 | 503; reason: "signed_out" | "not_member" | "telegram_unavailable" };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function createGate(mode: AuthMode, deps: GateDeps = {}): { authRouter: Router; requireMember: express.RequestHandler } {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const authRouter = express.Router();

  if (mode.kind === "unconfigured") {
    console.error(`Member gate not configured; data routes stay closed. Missing: ${mode.missing.join(", ")}`);
    const closed = (_req: Request, res: Response) => {
      res.status(503).json({ error: "closed", reason: "auth_not_configured" });
    };
    authRouter.use(closed);
    return { authRouter, requireMember: closed };
  }

  if (mode.kind === "bypass") {
    const isLocal = (req: Request) => LOCAL_HOSTS.has(req.hostname);
    authRouter.get("/config", (_req, res) => res.json({ botUsername: null, devBypass: true }));
    authRouter.get("/me", (req, res) => {
      if (isLocal(req)) return res.json({ name: "Local dev" });
      res.status(401).json({ reason: "signed_out" });
    });
    authRouter.post("/logout", (_req, res) => res.status(204).end());
    const requireMember = (req: Request, res: Response, next: NextFunction) => {
      if (isLocal(req)) return next();
      res.status(401).json({ reason: "signed_out" });
    };
    return { authRouter, requireMember };
  }

  const cfg = mode.config;

  // One in-flight or recent answer per Telegram user, so a page that fires ten
  // requests on a stale cookie makes one Bot API call, not ten.
  const memberCache = new Map<number, { at: number; result: Promise<boolean> }>();
  function checkMember(tgId: number): Promise<boolean> {
    const hit = memberCache.get(tgId);
    if (hit && now() - hit.at < MEMBER_CACHE_SECONDS) return hit.result;
    if (memberCache.size > 5000) memberCache.clear();
    const result = getChatMember(cfg.botToken, cfg.groupId, tgId, fetchImpl).then(isAllowedMember);
    memberCache.set(tgId, { at: now(), result });
    // A failed check isn't cached, so the next request tries again.
    result.catch(() => memberCache.delete(tgId));
    return result;
  }

  function setSession(res: Response, session: SessionPayload) {
    const remaining = Math.max(0, session.iat + cfg.sessionTtlSeconds - now());
    res.setHeader("Set-Cookie", sessionCookieHeader(encodeSession(session, cfg.sessionSecret), remaining));
  }

  /** Validates the cookie and, once an hour, re-confirms membership. Refreshes
   * or clears the cookie on `res` as a side effect. */
  async function checkSession(req: Request, res: Response): Promise<SessionCheck> {
    const t = now();
    const session = decodeSession(readCookie(req.headers.cookie, SESSION_COOKIE), cfg.sessionSecret, t, cfg.sessionTtlSeconds);
    if (!session) return { ok: false, status: 401, reason: "signed_out" };
    if (t - session.memberCheckedAt <= MEMBER_RECHECK_SECONDS) return { ok: true, session };
    try {
      if (!(await checkMember(session.tgId))) {
        res.setHeader("Set-Cookie", clearedSessionCookieHeader());
        return { ok: false, status: 401, reason: "not_member" };
      }
    } catch (err) {
      if (!(err instanceof TelegramUnavailableError)) throw err;
      console.error(`Membership re-check failed for ${session.tgId}:`, err.message);
      if (t - session.memberCheckedAt <= MEMBER_GRACE_SECONDS) return { ok: true, session };
      return { ok: false, status: 503, reason: "telegram_unavailable" };
    }
    const refreshed = { ...session, memberCheckedAt: t };
    setSession(res, refreshed);
    return { ok: true, session: refreshed };
  }

  authRouter.get("/config", (_req, res) => {
    res.json({ botUsername: cfg.botUsername, devBypass: false });
  });

  authRouter.post("/telegram", async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const fieldsOk =
      body &&
      typeof body === "object" &&
      Object.values(body).every((v) => typeof v === "string" || typeof v === "number");
    if (!fieldsOk || !isGenuineLogin(body, cfg.botToken) || !isRecentLogin(body.auth_date, now())) {
      return res.status(401).json({ reason: "invalid" });
    }
    const tgId = Number(body.id);
    if (!Number.isSafeInteger(tgId)) return res.status(401).json({ reason: "invalid" });
    let allowed: boolean;
    try {
      // A fresh answer at sign-in, not the cache: someone just added to the
      // group shouldn't wait out an old "no".
      memberCache.delete(tgId);
      allowed = await checkMember(tgId);
    } catch (err) {
      if (!(err instanceof TelegramUnavailableError)) throw err;
      console.error(`Membership check at sign-in failed for ${tgId}:`, err.message);
      return res.status(503).json({ reason: "telegram_unavailable" });
    }
    if (!allowed) return res.status(403).json({ reason: "not_member" });
    const name =
      [body.first_name, body.last_name].filter((v) => typeof v === "string" && v).join(" ") ||
      (typeof body.username === "string" ? body.username : "") ||
      "Member";
    const t = now();
    setSession(res, { tgId, name, iat: t, memberCheckedAt: t });
    res.json({ name });
  });

  authRouter.get("/me", async (req, res) => {
    const check = await checkSession(req, res);
    if (!check.ok) return res.status(check.status).json({ reason: check.reason });
    res.json({ name: check.session.name });
  });

  authRouter.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", clearedSessionCookieHeader());
    res.status(204).end();
  });

  const requireMember = (req: Request, res: Response, next: NextFunction) => {
    checkSession(req, res).then((check) => {
      if (check.ok) return next();
      res.status(check.status).json({ reason: check.reason });
    }, next);
  };

  return { authRouter, requireMember };
}
