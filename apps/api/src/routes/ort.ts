import { Router } from "express";
import type { CanonicalWindow } from "@brokerforce/types";

// Per docs/API.md §5 and docs/specs/004-ort-engine/spec.md.
export const ortRouter = Router();

function parseWindow(q: unknown): CanonicalWindow {
  const allowed: CanonicalWindow[] = [30, 90, 200];
  const num = Number(q);
  return (allowed as number[]).includes(num) ? (num as CanonicalWindow) : 90;
}

// GET /pairs/:pairId/ort?window=
ortRouter.get("/:pairId/ort", (req, res) => {
  const window = parseWindow(req.query.window);
  // TODO: query ort_scores (docs/Database.md §3) for this pair + window.
  // Must include score, quadrantLabel, trendDirection, confidence per docs/ORT.md.
  res.status(501).json({ error: "not implemented", pairId: req.params.pairId, window });
});

// GET /pairs/:pairId/ort/history?window=
ortRouter.get("/:pairId/ort/history", (req, res) => {
  const window = parseWindow(req.query.window);
  // TODO: query ort_scores history for the sparkline — single window only, no blending
  // across windows per docs/specs/004-ort-engine/spec.md acceptance criteria.
  res.status(501).json({ error: "not implemented", pairId: req.params.pairId, window });
});

// GET /pairs/ort?sort=desc&window=90&limit= — note: no :pairId here, this is the ranked list.
// Mounted separately since it doesn't share the /:pairId/ort path shape.
export const ortRankedRouter = Router();
ortRankedRouter.get("/ort", (req, res) => {
  const window = parseWindow(req.query.window);
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  // TODO: ranked query, excluding excluded-stable and limited-tier pairs by default
  // per docs/ORT.md §5, unless explicitly requested otherwise.
  res.status(501).json({ error: "not implemented", window, limit });
});
