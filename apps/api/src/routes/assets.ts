import { Router } from "express";

// Per docs/API.md §2.
export const assetsRouter = Router();

assetsRouter.get("/:symbol", (req, res) => {
  // TODO: hydrate from the `assets` table (docs/Database.md §3) — snapshot fields only;
  // historical candles come from a separate query against asset_price_history.
  res.status(501).json({ error: "not implemented", symbol: req.params.symbol });
});
