-- Supabase ingest watchdog (external scheduler hardening).
-- Documented in docs/ingestion-automation.md ("Scheduler reliability").
--
-- This runs in the SUPABASE project database, NOT the app migration chain
-- (packages/db/migrations). It re-triggers the GitHub "Daily Ingestion" workflow
-- when the pipeline's output has gone stale, covering for GitHub cron silently
-- dropping scheduled runs. Requires pg_cron, pg_net, supabase_vault (all enabled).
--
-- One-time, done by a human in the Supabase SQL editor (token never in the repo):
--   select vault.create_secret(
--     'ghp_your_token_here',
--     'github_actions_dispatch_token',
--     'GitHub fine-grained PAT (Actions:write) for the ingest watchdog');

CREATE OR REPLACE FUNCTION public.trigger_github_ingest_if_stale(max_age_hours int DEFAULT 26)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tok text;
  last_fresh timestamptz;
  req_id bigint;
BEGIN
  -- ort_scores is the LAST pipeline step, so a fresh row means the whole daily
  -- run succeeded end-to-end. Only dispatch when it's gone stale.
  SELECT max(computed_at) INTO last_fresh FROM public.ort_scores;
  IF last_fresh IS NOT NULL AND last_fresh > now() - make_interval(hours => max_age_hours) THEN
    RETURN 'fresh (' || last_fresh || ') -- no dispatch';
  END IF;

  SELECT decrypted_secret INTO tok FROM vault.decrypted_secrets WHERE name = 'github_actions_dispatch_token';
  IF tok IS NULL THEN
    RAISE EXCEPTION 'vault secret github_actions_dispatch_token not found -- add it before the watchdog can fire';
  END IF;

  SELECT net.http_post(
    url := 'https://api.github.com/repos/0xTimberZx/brokerForce/actions/workflows/ingest-pools-daily.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'brokerforce-supabase-scheduler',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main')
  ) INTO req_id;

  RETURN 'stale (' || COALESCE(last_fresh::text, 'never') || ') -> dispatched (net req ' || req_id || ')';
END;
$$;

-- Not callable over the API (it reads a secret): only postgres / the cron runner.
REVOKE EXECUTE ON FUNCTION public.trigger_github_ingest_if_stale(int) FROM public;
REVOKE EXECUTE ON FUNCTION public.trigger_github_ingest_if_stale(int) FROM anon, authenticated;

-- Every 3 hours: dispatch only if stale -> ≤3h recovery after a GitHub miss,
-- zero wasted runs when GitHub's own 06:00 cron worked.
SELECT cron.schedule('brokerforce-ingest-watchdog', '0 */3 * * *',
  $$ SELECT public.trigger_github_ingest_if_stale(); $$);
