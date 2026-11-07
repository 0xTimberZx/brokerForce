import express from "express";
import { app } from "./app.js";

// Vercel serverless entry (spec 022, Phase 0). The web app calls the API at
// /api/* (apps/web/src/api/client.ts), and Vercel hands the function the
// original request path, so the app is mounted under /api. The bare mount
// behind it catches a request that arrives without the prefix.
const root = express();
root.disable("x-powered-by");

// Production stays closed until the Phase 1 member gate ships. On Vercel's
// Hobby plan, Vercel Authentication protects preview deployments only, so the
// production address would otherwise serve data to anyone. Previews are
// unaffected; health checks stay open. TERMINAL_PUBLIC=1 lifts the guard,
// which Phase 1 removes in favour of the real gate.
root.use((req, res, next) => {
  const closed = process.env.VERCEL_ENV === "production" && process.env.TERMINAL_PUBLIC !== "1";
  const path = req.path.replace(/^\/api/, "") || "/";
  if (!closed || path === "/health") return next();
  res.status(503).json({ error: "closed", reason: "The terminal opens to group members once sign-in is live." });
});

root.use("/api", app);
root.use(app);

export default root;
