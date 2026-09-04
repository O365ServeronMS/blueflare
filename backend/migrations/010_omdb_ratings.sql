-- Rotten Tomatoes / Metacritic scores from OMDb, plus the daily request budget.
--
-- Two deliberate separations, both learned from earlier migrations:
--
-- 1. The imdb id OMDb was queried with lives in its own column. It may be
--    *guessed* — resolved from TMDB /external_ids for rows the providers never
--    supplied one for — and `movies.imdb_id` is load-bearing for identity:
--    `movies_imdb_identity_idx` is unique and `findByImdbId()` merges rows on
--    it, so one wrong guess would fuse two different titles together. The
--    identity resolver never reads `omdb_imdb_id`. Same containment as
--    `tmdb_image_fallback_id` in 009.
--
-- 2. Scores land in dedicated columns, never in the `ratings` jsonb. That blob
--    is provider-owned and rewritten wholesale by `upsertCanonical()` on every
--    sync cycle, which would erase OMDb data within one SYNC_INTERVAL_MS.
--
-- Reverting every OMDb-derived score is a single statement:
--   UPDATE movies SET omdb_status='none', omdb_imdb_id=NULL, omdb_checked_at=NULL,
--     omdb_tomatometer=NULL, omdb_metascore=NULL, omdb_imdb_rating=NULL;

ALTER TABLE movies ADD COLUMN IF NOT EXISTS omdb_status text NOT NULL DEFAULT 'none';
ALTER TABLE movies ADD COLUMN IF NOT EXISTS omdb_imdb_id text;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS omdb_checked_at timestamptz;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS omdb_tomatometer smallint;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS omdb_metascore smallint;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS omdb_imdb_rating numeric(3,1);

-- 'no-tmdb-id'/'no-imdb-id' record *why* a row is unreachable so the candidate
-- query can skip it cheaply instead of re-deriving that every cycle.
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_omdb_status_check;
ALTER TABLE movies ADD CONSTRAINT movies_omdb_status_check CHECK (
  omdb_status IN ('none', 'matched', 'unmatched', 'no-imdb-id', 'no-tmdb-id', 'error')
);

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_omdb_tomatometer_check;
ALTER TABLE movies ADD CONSTRAINT movies_omdb_tomatometer_check CHECK (
  omdb_tomatometer IS NULL OR omdb_tomatometer BETWEEN 0 AND 100
);
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_omdb_metascore_check;
ALTER TABLE movies ADD CONSTRAINT movies_omdb_metascore_check CHECK (
  omdb_metascore IS NULL OR omdb_metascore BETWEEN 0 AND 100
);
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_omdb_imdb_rating_check;
ALTER TABLE movies ADD CONSTRAINT movies_omdb_imdb_rating_check CHECK (
  omdb_imdb_rating IS NULL OR omdb_imdb_rating BETWEEN 0 AND 10
);

-- Candidate selection is demand-driven: the job resolves a slug list from the
-- home/list viewmodels, then asks this index which of those are untried or due
-- for a re-check. Untried rows sort first.
CREATE INDEX IF NOT EXISTS movies_omdb_pending_idx
  ON movies (omdb_checked_at NULLS FIRST)
  WHERE catalog_state = 'ready'
    AND omdb_status NOT IN ('no-imdb-id', 'no-tmdb-id');

-- OMDb's free tier allows 1000 requests per UTC day and answers 401 for the
-- rest of the day once that is spent. The counter lives here rather than in
-- Valkey because Valkey runs `allkeys-lru` under a memory cap: an evicted
-- counter would silently reset the budget mid-day and burn the key.
CREATE TABLE IF NOT EXISTS omdb_budget (
  day date PRIMARY KEY,
  used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
