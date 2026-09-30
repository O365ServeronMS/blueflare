-- Evidence-based TMDB identity for rows the provider gave no tmdb_id.
-- Deliberately separate from tmdb_id/tmdb_media_type: writing tmdb_id would flip
-- tmdb_identity_status to 'pending' and let TMDB artwork overwrite catalog images.
-- A verified match is cast-corroborated (see src/tmdbMatch.js) and is read only by
-- credits, never by the image pipeline.
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_match_id bigint;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_match_media_type text;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_match_status text;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_match_evidence jsonb;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_match_checked_at timestamptz;

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_match_media_type_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_match_media_type_check CHECK (
  tmdb_match_media_type IS NULL OR tmdb_match_media_type IN ('movie', 'tv')
);
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_match_status_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_match_status_check CHECK (
  tmdb_match_status IS NULL OR tmdb_match_status IN ('verified', 'none', 'unverifiable', 'error')
);

CREATE INDEX IF NOT EXISTS movies_tmdb_match_verified_idx
  ON movies (tmdb_match_media_type, tmdb_match_id)
  WHERE tmdb_match_status = 'verified';
