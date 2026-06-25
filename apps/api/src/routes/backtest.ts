import { Router } from "express";
import type { BacktestRequest } from "@brokerforce/types";

// Per docs/API.md §7 and docs/specs/006-backtester/spec.md.
export const backtestRouter = Router();

backtestRouter.post("/", (req, res) => {
  const body = req.body as BacktestRequest;
  // TODO: run the simulation against asset_price_history at the granularity decided
  // in docs/Database.md §2 (hourly, proposed), persist to backtest_results, return result.
  // Per spec acceptance criteria: if requested period exceeds available history, either
  // shorten with a clear note or decline with a clear reason — never silently extrapolate.
  res.status(501).json({ error: "not implemented", request: body });
});

backtestRouter.get("/:simulationId", (req, res) => {
  // TODO: retrieve from backtest_results (docs/Database.md §3) by id.
  res.status(501).json({ error: "not implemented", simulationId: req.params.simulationId });
});
