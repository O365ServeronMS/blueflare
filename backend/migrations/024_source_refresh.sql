-- Provider list refresh. last_seen_at: last time a provider list page contained
-- this source (touched even when the detail fetch was skipped as unchanged).
-- not_found_count/first_not_found_at: stale-refresh 404 bookkeeping; reset when a
-- detail upsert succeeds. Nothing here changes availability by itself.
ALTER TABLE movie_provider_sources
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS not_found_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_not_found_at timestamptz;

UPDATE movie_provider_sources SET last_seen_at = last_success_at WHERE last_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS movie_provider_sources_stale_idx
  ON movie_provider_sources (provider, last_success_at)
  WHERE availability;
