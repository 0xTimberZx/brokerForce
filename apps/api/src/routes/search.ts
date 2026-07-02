import { Router } from "express";

// Per docs/API.md §4 and docs/specs/002-search/spec2.md.
export const searchRouter = Router();

searchRouter.get("/", (req, res) => {
  const q = String(req.query.q ?? "");
  // TODO: fuzzy match against assets + known pairs; join in canonical 90d ORT scores
  // for any pair results, server-side, to avoid N+1 lookups per docs/specs/002-search.
  res.status(501).json({ error: "not implemented", q, results: { assets: [], pairs: [], pools: [] } });
});
