# BrokerForce

A protocol-agnostic Liquidity Intelligence Platform that helps liquidity providers discover, evaluate, and optimize concentrated liquidity opportunities across DeFi.

This repository is built **docs-first**. Before reading any code, read:

1. [`docs/Vision.md`](docs/Vision.md) — what BrokerForce is and why it exists.
2. [`docs/Product_Principles.md`](docs/Product_Principles.md) — the rules every feature is held to, including the one that matters most: nothing gets coded until it can be explained in one sentence.
3. [`docs/Roadmap.md`](docs/Roadmap.md) — the Year/Phase plan, and the actual engineering build order (they're not the same thing — see §4 of that doc).
4. [`docs/Architecture.md`](docs/Architecture.md) — system layers, data models, and the architectural decisions made so far (including the ones still open).
5. [`specs/`](specs/) — one numbered spec per feature, each the development checklist for that feature before any code traces back to it.

`docs/ORT.md`, `docs/Analytics.md`, `docs/Database.md`, and `docs/API.md` go deeper on the scoring engine, metric methodology, schema, and endpoint contracts respectively. `docs/Glossary.md` defines every term used across all of the above.

## Status

**Sprint 0 is complete and approved.** The full constitution (`docs/`) and all seven feature specs (`specs/`) have gone through Draft → Discussion → Revision → Approve → Commit. Decisions made along the way that are worth knowing before touching code:

- **Active-tier gate:** a pair qualifies as active/popular if it has a real pool with TVL ≥ $50,000 and 7-day average volume ≥ $10,000. Stable–stable pairs are excluded regardless. See `Architecture.md` §5.
- **ORT scoring:** 0–100 composite across seven weighted components (Volume 20%, Range Stability 20%, Volatility 15%, Time in Range 15%, Correlation/Liquidity/Market Cap Stability 10% each); three canonical windows (30d/90d/200d), 90d default. See `ORT.md` and `Analytics.md`.
- **Quadrant labeling:** two-axis (Volume × Volatility) presentation layer on top of the ORT score — Prime/Active/Quiet/Avoid — with a trend overlay. Percentile-based, with a 10-pair minimum population before it's trusted. See `ORT.md` §6, `Analytics.md` §4.
- **Auth:** local-storage only for now (Watchlists, recently-viewed) — no accounts, no wallet sign-in until external integrations actually require it. See `Architecture.md` §5.
- **Data granularity:** daily now, upgrading to hourly when `006 Backtester` enters the Build phase. No retention cap, revisit at 50 active-tier pools or 9 months of hourly data. See `Database.md` §2, §4.
- **Pool ingestion:** continuous polling for active-tier pairs only; limited/excluded-stable tier pools are fetched live, on-demand (5s timeout, 10-minute result cache). See `Database.md` §3, `005 Pool Explorer`.
- **Pair Popularity:** percentile-based composite of swap frequency, LP count, and volume — display-only, active-tier only, doesn't feed ORT or the tier gate. See `Analytics.md` §3a.

The monorepo wires together correctly (shared types, stubbed API routes per `docs/API.md`, a minimal React/Tailwind shell) but contains no real business logic yet — every route returns `501 not implemented` on purpose. Per `Roadmap.md` §4, the actual build order is **ingestion → Asset model → Pair Engine → `003` → `004` → `005`/`006` → `001`/`002`/`007`** — not the spec numbering, which follows the user-facing dashboard flow instead.

## Structure

```
docs/        — the constitution (Phase 0)
specs/       — numbered feature specs (Phase 1)
apps/api     — Express/TypeScript API, stubbed routes per docs/API.md
apps/web     — React/TypeScript/Vite/Tailwind app, scaffold-only
packages/types — shared TypeScript types, mirrors docs/Database.md
```

## Getting Started

```bash
npm install
npm run dev:api   # API on :4000
npm run dev:web   # Web app via Vite
```

## Contributing

Every change should trace back to a spec in `specs/`. If you're about to write code and can't point to which spec it implements, that's the actual next step — not the code. See `docs/Product_Principles.md` §4 for the full Define → Design → Build discipline this project runs on.
