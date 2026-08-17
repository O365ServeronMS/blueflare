-- Poster fallback for catalog rows the providers never supplied artwork for.
--
-- These rows carry no tmdb_id/imdb_id at all, so the verified-by-id pipeline in
-- `listTmdbImageCandidates()` can never reach them. Identity is instead guessed
-- from `original_title`, which is materially weaker evidence: a wrong guess must
-- never be able to merge two different titles together. The matched TMDB id is
-- therefore recorded in a dedicated column that the identity resolver never
-- reads, and `movies.tmdb_id` is deliberately left NULL.
--
-- Reverting every search-derived poster is a single statement:
--   UPDATE movies SET tmdb_thumb_asset_id=NULL, tmdb_poster_asset_id=NULL,
--     tmdb_image_fallback_status='none', tmdb_image_fallback_id=NULL
--   WHERE tmdb_image_fallback_status='matched';

ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_image_fallback_status text NOT NULL DEFAULT 'none';
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_image_fallback_id bigint;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_image_fallback_checked_at timestamptz;

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_image_fallback_status_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_image_fallback_status_check CHECK (
  tmdb_image_fallback_status IN ('none', 'matched', 'unmatched', 'ambiguous', 'error')
);

-- Drives candidate selection: untried rows first, then rows due for a re-check.
CREATE INDEX IF NOT EXISTS movies_tmdb_image_fallback_pending_idx
  ON movies (tmdb_image_fallback_checked_at)
  WHERE tmdb_image_fallback_status <> 'matched'
    AND thumb_asset_id IS NULL
    AND poster_asset_id IS NULL;
