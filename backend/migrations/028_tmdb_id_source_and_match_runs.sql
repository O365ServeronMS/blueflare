-- Where a movies.tmdb_id came from. Rows the provider supplied are 'provider'; ids the
-- worker assigns after ranking real TMDB candidates (phase C) will be 'inferred', so they
-- can be audited and undone without touching provider-owned identity. No behaviour reads
-- this column yet. The CHECK is NOT VALID: new writes are validated, existing rows are
-- not rescanned under a lock (every value so far is NULL or 'provider' anyway).
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_id_source text;
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_id_source_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_id_source_check
  CHECK (tmdb_id_source IS NULL OR tmdb_id_source IN ('provider', 'inferred')) NOT VALID;

-- Existing ids all came from providers. One cheap statement; only touches rows still NULL,
-- so a re-run is a no-op.
UPDATE movies SET tmdb_id_source = 'provider' WHERE tmdb_id IS NOT NULL AND tmdb_id_source IS NULL;

-- One row per (run, title): the candidates shown to the model, its choice and the evidence.
-- Audit trail and work queue for the AI match pass. Re-creatable from TMDB, not irreplaceable.
CREATE TABLE IF NOT EXISTS tmdb_match_ai_runs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'dry-run' CHECK (mode IN ('dry-run', 'apply')),
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen_tmdb_id bigint CHECK (chosen_tmdb_id IS NULL OR chosen_tmdb_id > 0),
  media_type text CHECK (media_type IS NULL OR media_type IN ('movie', 'tv')),
  confidence numeric(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'chosen', 'rejected', 'applied', 'skipped', 'error')),
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, movie_id)
);
CREATE INDEX IF NOT EXISTS tmdb_match_ai_runs_movie_idx ON tmdb_match_ai_runs (movie_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tmdb_match_ai_runs_pending_idx ON tmdb_match_ai_runs (status) WHERE status = 'pending';
