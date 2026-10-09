# Daily Ingestion Automation

How the daily data pipeline runs unattended, and what it needs from you once.

## The design constraint that shapes everything

The active-tier gate (`Architecture.md` §5, `apps/ingestion/src/tier-gate.ts`)
promotes a pair only after **7 distinct days of stored volume snapshots** show
a pool holding TVL ≥ $50k with a 7-day average volume ≥ $10k. That evidence
accumulates in `pool_history` **across runs** — which means the pipeline must
write to a **persistent database**. An ephemeral database (like a GitHub
Actions service container that's created and destroyed per run) resets
`pool_history` to zero every day, so `distinctDays` never exceeds 1 and no
pair can ever promote. The first version of this workflow had exactly that
flaw; the current one refuses to run without a real `DATABASE_URL` secret.

## One-time setup

1. Provision a hosted Postgres database. Any of these work:
   - **Supabase** (already in the planned stack, `Architecture.md` §6) — note
     Supabase has no TimescaleDB extension; `001_init.sql` handles this by
     creating plain tables where the extension is unavailable.
   - **Timescale Cloud** — if you want real hypertables.
   - **Railway / Render** — plain Postgres, same graceful degradation.
2. Add the connection string as a repo secret:
   Settings → Secrets and variables → Actions → New repository secret,
   name `DATABASE_URL`.
3. Optionally trigger the workflow once by hand (Actions → Daily Ingestion →
   Run workflow) instead of waiting for the schedule.

## What runs daily (`.github/workflows/ingest-pools-daily.yml`, 06:00 UTC)

| Step | Command | What it does |
|---|---|---|
| 1 | `npm run migrate` | Applies any new migrations; `schema_migrations` makes re-runs no-ops |
| 2 | `npm run ingest` | Asset prices/volume/market-cap from CoinGecko |
| 3 | `npm run generate-pairs` | Upserts the pair universe (tier preserved) |
| 4 | `npm run compute-metrics` | Per-pair statistics for all three windows |
| 5 | `npm run ingest-pools` | Pool snapshots via GeckoTerminal + tier-gate evaluation |
| 6 | `npm run compute-ort` | ORT scores for active-tier pairs |

Pool ingestion runs before ORT scoring so a pair promoted today gets scored
today. Everything is idempotent — a manually re-triggered run is safe.

## What to expect on the timeline

- **Day 1:** pools table populates for pairs with real on-chain pools; first
  `pool_history` snapshots land. `compute-ort` reports zero scores (no active
  pairs yet) — expected, not a failure.
- **Days 2–6:** snapshots accumulate; `ingest-pools` logs show gate evidence
  building.
- **Day 7+:** the first pairs clearing the bar are promoted (look for
  `PROMOTED <A>/<B> to active tier` in the run log), and `compute-ort`
  produces the first real scores on the next step of that same run.

## Demotion is deliberately manual

`ingest-pools` logs `DEMOTION CANDIDATE` for active pairs that have slipped
below the bar but never demotes automatically — the demotion policy
(immediate? hysteresis? grace period?) is an open product decision. Watch the
logs and decide with real data.

## Scheduler reliability — Supabase watchdog (belt-and-suspenders)

GitHub's cron scheduler is best-effort: it silently **dropped this repo's
scheduled runs for 13 days** (2026-09-24 → 2026-10-07) while the workflow still
showed `state: active`. Scores froze with no failure to alert on. GitHub also
auto-disables a workflow's *schedule* after 60 days of repo inactivity (manual
`workflow_dispatch` keeps working regardless).

So an **external watchdog in Supabase** re-triggers the pipeline when — and only
when — the data has actually gone stale. It rides `pg_cron` + `pg_net` +
`supabase_vault` (all already enabled on the project):

- **`public.trigger_github_ingest_if_stale(max_age_hours int default 26)`** — a
  `SECURITY DEFINER` function that checks `max(ort_scores.computed_at)` (the
  pipeline's *last* step, so freshness there means the whole run succeeded). If
  fresh, it no-ops. If stale, it reads a GitHub token from Vault and `pg_net`
  POSTs a `workflow_dispatch` (`ref: main`) to `ingest-pools-daily.yml`.
- **`cron.job` `brokerforce-ingest-watchdog`** — runs it every 3 hours
  (`0 */3 * * *`). Recovery latency after a GitHub miss is ≤3h instead of
  indefinite. No wasted runs: when GitHub's own 06:00 cron works, `ort_scores`
  is fresh and the watchdog does nothing. The workflow's `concurrency` group
  (`cancel-in-progress: false`) means a rare overlap just queues; the pipeline
  is idempotent either way.

GitHub's native 06:00 cron is **left in place as the primary**; the watchdog is
the safety net.

### One-time token setup (do this once, in the Supabase SQL editor)

The watchdog needs a GitHub token to dispatch. Store it in Vault — never in the
repo or a chat:

1. Create a **fine-grained PAT** scoped to `0xTimberZx/brokerForce` with
   **Repository permissions → Actions: Read and write** (Metadata: Read is
   included automatically). No other scopes.
2. In Supabase → SQL Editor, run (paste the token in place of `ghp_…`):
   ```sql
   select vault.create_secret(
     'ghp_your_token_here',
     'github_actions_dispatch_token',
     'GitHub fine-grained PAT (Actions:write) for the ingest watchdog'
   );
   ```
3. Rotate by updating that Vault secret; nothing else changes.

Until the secret exists the watchdog raises a clear error *only if it fires
while stale* — while scores are fresh it simply no-ops, so there's no rush and
no noise. Verify the whole chain by forcing a dispatch:
`select public.trigger_github_ingest_if_stale(0);` (0h age = always stale) and
confirm a new "Daily Ingestion" run appears in Actions.

