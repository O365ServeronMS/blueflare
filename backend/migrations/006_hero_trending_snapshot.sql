CREATE TABLE IF NOT EXISTS hero_trending_entries (
  position smallint PRIMARY KEY CHECK (position BETWEEN 1 AND 24),
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  tmdb_id bigint NOT NULL,
  fetched_at timestamptz NOT NULL,
  UNIQUE (movie_id),
  UNIQUE (tmdb_id)
);

CREATE INDEX IF NOT EXISTS hero_trending_entries_movie_idx
  ON hero_trending_entries (movie_id);

CREATE TABLE IF NOT EXISTS hero_trending_refresh_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  candidate_count integer,
  matched_count integer
);
