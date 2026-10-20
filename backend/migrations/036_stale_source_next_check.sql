-- Stale-source lane scheduling. Every refresh attempt that does not end in a successful
-- upsert pushes the source back to stale_next_check_at, so a source that keeps failing
-- (404, transient, unique conflict) cannot hold the head of the queue. Reset by upsert.
ALTER TABLE movie_provider_sources
  ADD COLUMN IF NOT EXISTS stale_next_check_at timestamptz;
