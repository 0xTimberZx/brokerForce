import { Router } from "express";

// Per docs/API.md §6 and docs/specs/005-pool-explorer/spec.md.
export const poolsRouter = Router();

// GET /pairs/:assetA/:assetB/pools?chain=&dex=&feeTier=&minTvl=
poolsRouter.get("/:assetA/:assetB/pools", (req, res) => {
  // TODO: filter the `pools` table (docs/Database.md §3) by query params, AND logic
  // per docs/specs/005-pool-explorer acceptance criteria.
  res.status(501).json({ error: "not implemented", ...req.params, filters: req.query });
});

// Mounted separately below since these don't share the /:assetA/:assetB prefix.
export const poolDetailRouter = Router();

poolDetailRouter.get("/:poolId", (req, res) => {
  res.status(501).json({ error: "not implemented", poolId: req.params.poolId });
});

poolDetailRouter.get("/:poolId/history", (req, res) => {
  res.status(501).json({ error: "not implemented", poolId: req.params.poolId, window: req.query.window });
});
