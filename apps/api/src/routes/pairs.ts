import { Router } from "express";
import type { CanonicalWindow } from "@brokerforce/types";

// Per docs/API.md §3. Pool endpoints live in pools.ts; ORT endpoints live in ort.ts,
// despite all three sharing the /pairs/* prefix — kept separate by concern, not by URL.
export const pairsRouter = Router();

function parseWindow(q: unknown): CanonicalWindow {
  const allowed: CanonicalWindow[] = [30, 90, 200];
  const num = Number(q);
  return (allowed as number[]).includes(num) ? (num as CanonicalWindow) : 90; // default per docs/ORT.md §3
}

pairsRouter.get("/:assetA/:assetB", (req, res) => {
  const window = parseWindow(req.query.window);
  // TODO: query pair_metrics (docs/Database.md §3) for this pair + window.
  res.status(501).json({ error: "not implemented", ...req.params, window });
});

pairsRouter.get("/:assetA/:assetB/history", (req, res) => {
  const window = parseWindow(req.query.window);
  // TODO: query asset_price_history / continuous aggregates for the chart series.
  res.status(501).json({ error: "not implemented", ...req.params, window });
});
