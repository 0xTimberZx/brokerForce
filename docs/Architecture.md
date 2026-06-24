# Architecture

## 1. Design Principle

BrokerForce is an analytics hub, not a standalone dApp. Every protocol, DEX, or strategy plugs into a common interface so the analytics engine can compare Uniswap, Aerodrome, PancakeSwap, future strategies, and eventually TradFi instruments without rewriting core logic. Concretely: nothing in the Pair Engine, Analytics layer, or ORT Engine should contain protocol-specific branching. Protocol differences are absorbed at the ingestion layer, not propagated upward.

## 2. System Layers

```
Ingestion Layer        →  per-chain/per-DEX/per-exchange data pulled into a common format
        ↓
Data Models             →  Asset, Pair, Pool (see §4)
        ↓
Pair Engine              →  generates every relevant pair, computes pair-level statistics
        ↓
Analytics / ORT Engine   →  derives the composite ORT score from Pair Engine outputs
        ↓
API Layer                →  REST endpoints consumed by frontend (see Database.md / API.md for contracts)
        ↓
Frontend                 →  React app composing dashboard, search, pair analysis, pool explorer,
                            backtester, watchlists — see specs/001–007
```

Each layer should be replaceable without forcing a rewrite of the layers around it. The clearest test: a new DEX or chain should require new ingestion code only, not changes to the Pair Engine, ORT Engine, or frontend components.

## 3. Build Dependency Order

The layers above are listed top-to-bottom for understanding, but the actual build order runs bottom-up: Ingestion → Data Models → Pair Engine → Analytics/ORT → API → Frontend. See `Roadmap.md` §4 for the specific spec-by-spec sequence — `004 ORT Engine` is a hard dependency for most user-facing specs (`001`, `002`, `007`) despite its spec number suggesting otherwise.

## 4. Data Models

**Asset**
- Symbol, Class (blue chip / stable / growth-exotic / degen), Historical candles (OHLCV), Market cap, Volume.

**Pair**
- Asset A, Asset B, Correlation, Delta, ORT score(s), Suggested range, Time in range, Fee estimate, Backtest results.
- Volume-derived fields: `avg_volume_24h`, `avg_volume_7d`, `avg_volume_30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`, `fee_opportunity_score`.

**Pool**
- DEX, Fee tier, TVL, Volume, Active liquidity, Chain.

Full field-level detail (types, computation formulas, refresh cadence) belongs in `Database.md`, not here — this document covers structure and relationships, not schema.

## 5. Architectural Decisions on Record

Decisions made during spec work that have system-wide consequences, recorded here so they don't get silently re-litigated per-feature:

**ORT windowing (decided while speccing `004`):** ORT is computed and stored on a fixed, maintained set of canonical windows — **30d / 90d / 200d** — per pair, each independently scored. 90d is the default wherever a single score is shown (Pair Explorer sort, dashboard ranking, watchlist display). This is what keeps cross-pair comparison meaningful; user-selectable windows exist only in `003 Pair Analysis`'s exploratory statistics panel, and never override the canonical ORT number. Full detail in `ORT.md`.

**Open — backtest granularity (raised while speccing `006`):** range-exit detection accuracy depends on the granularity of stored historical price data. Daily-only data will systematically undercount range exits for volatile pairs. This needs a decision here or in `Database.md` before `006 Backtester` can be considered fully specified — current assumption in `006` is that the granularity will be disclosed to the user (e.g. "based on daily closes") rather than silently assumed to be more precise than it is, but the actual storage decision (daily vs. intraday, and at what storage cost) is still unresolved.

## 6. Tech Stack

- **Frontend:** HTML5, CSS3, JavaScript (ES2025+), React, TypeScript, Vite
- **Visualization:** TradingView Lightweight Charts, D3.js, Chart.js, AG Grid
- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL, Redis, TimescaleDB
- **APIs:** CoinGecko, DefiLlama, DexScreener, GeckoTerminal, Alchemy, Infura, QuickNode, Uniswap Subgraph, PancakeSwap APIs, Aerodrome APIs, Camelot APIs, Binance, Kraken, Coinbase Exchange, Alpha Vantage, Polygon.io, Twelve Data
- **Libraries:** math.js, simple-statistics, ml-matrix, TensorFlow.js, ONNX Runtime Web, Python (offline training)
- **Infrastructure:** GitHub, GitHub Actions, Cloudflare, Vercel, Railway or Render, Supabase
- **Dev tools:** VS Code, ESLint, Prettier, Vitest, Playwright, Docker

TimescaleDB's presence in the stack is notable given the open granularity question in §5 — it's built for exactly this kind of time-series-at-scale problem, which suggests the stack was already anticipating finer-than-daily storage even though the decision hasn't been formally made yet.

## 7. What This Document Doesn't Cover

Database schema and field-level detail → `Database.md`. API endpoint contracts → `API.md`. Scoring formulas and weights → `ORT.md` / `Analytics.md`. This document is structure and decisions, not implementation detail.
