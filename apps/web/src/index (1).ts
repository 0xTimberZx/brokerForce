import express from "express";
import { assetsRouter } from "./routes/assets.js";
import { pairsRouter } from "./routes/pairs.js";
import { ortRouter, ortRankedRouter } from "./routes/ort.js";
import { searchRouter } from "./routes/search.js";
import { poolsRouter, poolDetailRouter } from "./routes/pools.js";
import { backtestRouter } from "./routes/backtest.js";

const app = express();
app.use(express.json());

// Route groups mirror docs/API.md exactly — one router per section of that doc.
// No /watchlists/* router exists on purpose: watchlists are a client-side local-storage
// module per docs/specs/007-watchlists/spec.md, not a server endpoint, while
// docs/Architecture.md §5's local-storage-only auth decision holds.
app.use("/assets", assetsRouter);
app.use("/pairs", pairsRouter);
app.use("/pairs", ortRouter); // /pairs/:pairId/ort* — kept in its own file since it's a distinct concern
app.use("/pairs", ortRankedRouter); // /pairs/ort — ranked list, separate path shape from the line above
app.use("/search", searchRouter);
app.use("/pairs", poolsRouter); // /pairs/:assetA/:assetB/pools
app.use("/pools", poolDetailRouter); // /pools/:poolId, /pools/:poolId/history
app.use("/backtest", backtestRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(port, () => {
  console.log(`BrokerForce API listening on :${port}`);
});
