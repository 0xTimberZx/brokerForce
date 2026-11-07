// The Express app itself, with no listen() and no dotenv: shared by the
// long-running local server (index.ts) and the Vercel function (vercel.ts),
// so both serve exactly the same routes (spec 022, Phase 0).
import express from "express";
import { assetsRouter } from "./routes/assets.js";
import { pairsRouter } from "./routes/pairs.js";
import { ortRouter, ortRankedRouter } from "./routes/ort.js";
import { searchRouter } from "./routes/search.js";
import { poolsRouter, poolDetailRouter } from "./routes/pools.js";
import { backtestRouter } from "./routes/backtest.js";
import { rangeSuggestionsRouter, assetOpportunitiesRouter } from "./routes/rangeSuggestions.js";
import { sentimentRouter } from "./routes/sentiment.js";
import { catchAsyncErrors, errorHandler } from "./http/asyncErrors.js";

export const app = express();
app.use(express.json());

// Route groups mirror docs/API.md exactly — one router per section of that doc.
// No /watchlists/* router exists on purpose: watchlists are a client-side local-storage
// module per docs/specs/007-watchlists/spec7.md, not a server endpoint, while
// docs/Architecture.md §5's local-storage-only auth decision holds.
app.use("/assets", catchAsyncErrors(assetOpportunitiesRouter)); // /assets/:symbol/opportunities (008)
app.use("/assets", catchAsyncErrors(assetsRouter));
// ORDER MATTERS among the /pairs routers: pairsRouter's generic
// /:assetA/:assetB pattern also matches /<pairId>/ort (assetB = "ort") and
// its /:assetA/:assetB/history matches /<pairId>/ort/history -- with
// pairsRouter mounted first, every per-pair ORT request 404'd as
// "pair not found" and the frontend's ORT chip showed "pending" forever,
// even for scored pairs. The ORT routers' more-specific literal segments
// must be given the first chance to match.
app.use("/pairs", catchAsyncErrors(ortRankedRouter)); // /pairs/ort — ranked list
app.use("/pairs", catchAsyncErrors(ortRouter)); // /pairs/:pairId/ort, /pairs/:pairId/ort/history
app.use("/pairs", catchAsyncErrors(rangeSuggestionsRouter)); // /pairs/:pairId/range-suggestions (008) — same ordering rule
app.use("/pairs", catchAsyncErrors(poolsRouter)); // /pairs/:assetA/:assetB/pools
app.use("/pairs", catchAsyncErrors(pairsRouter)); // /pairs/:assetA/:assetB (+ /history) — generic, matches last
app.use("/search", catchAsyncErrors(searchRouter));
app.use("/pools", catchAsyncErrors(poolDetailRouter)); // /pools/:poolId, /pools/:poolId/history
app.use("/backtest", catchAsyncErrors(backtestRouter));
app.use("/sentiment", catchAsyncErrors(sentimentRouter)); // market Fear & Greed (008-adjacent sentiment cog)

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// After every route: turns a failed query into a prompt 500 instead of a
// hung request (see http/asyncErrors.ts).
app.use(errorHandler);
