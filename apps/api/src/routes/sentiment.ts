import { Router } from "express";
import { query } from "@brokerforce/db";
import type { MarketSentiment, SentimentClassification, SentimentResponse } from "@brokerforce/types";

// GET /sentiment -- the latest Crypto Fear & Greed reading per source plus a
// trailing window for a sparkline. Multi-source aware: one entry per distinct
// `source` in market_sentiment, so adding a provider surfaces here with no
// route change. Empty sources[] before the first ingestion run -- an honest
// pending state, not an error (same convention as the ORT ranked list).
export const sentimentRouter = Router();

const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 365;

interface SentimentRow {
  source: string;
  date: string;
  value: number;
  classification: string;
}

function toSentiment(row: SentimentRow): MarketSentiment {
  return {
    source: row.source,
    date: row.date,
    value: Number(row.value),
    classification: row.classification as SentimentClassification,
  };
}

sentimentRouter.get("/", async (req, res) => {
  const rawDays = Number(req.query.days);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), MAX_HISTORY_DAYS) : DEFAULT_HISTORY_DAYS;

  // One query for the trailing window across all sources, assembled in memory
  // -- the row count is tiny (sources x days) so there's no reason to fan out.
  const rows = await query<SentimentRow>(
    `SELECT source, "date"::text AS date, value, classification
     FROM market_sentiment
     WHERE "date" >= (CURRENT_DATE - ($1 || ' days')::interval)
     ORDER BY source ASC, "date" ASC`,
    [String(days)]
  );

  const bySource = new Map<string, MarketSentiment[]>();
  for (const row of rows) {
    const list = bySource.get(row.source) ?? [];
    list.push(toSentiment(row));
    bySource.set(row.source, list);
  }

  const response: SentimentResponse = {
    sources: [...bySource.entries()].map(([source, history]) => ({
      source,
      latest: history[history.length - 1]!, // window is ascending, last = newest
      history,
    })),
  };
  res.json(response);
});
