-- The AI match pass records the gate's verdict next to the run status so it can schedule
-- retries by outcome (none/unverifiable wait long, error waits short). status keeps its
-- 028 meaning: chosen (dry-run verified), applied, rejected (none/unverifiable), skipped
-- (verified but the identity assignment refused it), error.
ALTER TABLE tmdb_match_ai_runs ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE tmdb_match_ai_runs DROP CONSTRAINT IF EXISTS tmdb_match_ai_runs_outcome_check;
ALTER TABLE tmdb_match_ai_runs ADD CONSTRAINT tmdb_match_ai_runs_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('verified', 'unverifiable', 'none', 'error')) NOT VALID;
-- Retry lookup is "newest run of this movie", served by 028's (movie_id, created_at DESC) index.
