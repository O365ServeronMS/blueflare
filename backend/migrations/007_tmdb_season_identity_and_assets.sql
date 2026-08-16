ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_media_type text;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_season_number integer;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_identity_status text NOT NULL DEFAULT 'ineligible';
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_identity_verified_at timestamptz;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_image_checked_at timestamptz;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_thumb_asset_id uuid REFERENCES image_assets(id);
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_poster_asset_id uuid REFERENCES image_assets(id);

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_identity_type_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_identity_type_check CHECK (
  tmdb_media_type IS NULL OR tmdb_media_type IN ('movie', 'tv')
);
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_season_number_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_season_number_check CHECK (
  tmdb_season_number IS NULL OR tmdb_season_number >= 0
);
ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_tmdb_identity_status_check;
ALTER TABLE movies ADD CONSTRAINT movies_tmdb_identity_status_check CHECK (
  tmdb_identity_status IN ('ineligible', 'pending', 'verified', 'unavailable', 'mismatch', 'retry')
);

-- Historic rows do not retain a provider-supplied season. They remain ineligible
-- until a future KKPhim sync supplies the complete (type, id, season) tuple.
DROP INDEX IF EXISTS movies_tmdb_identity_idx;
CREATE UNIQUE INDEX IF NOT EXISTS movies_tmdb_movie_identity_idx
  ON movies (tmdb_id)
  WHERE tmdb_id IS NOT NULL AND tmdb_media_type = 'movie';
CREATE UNIQUE INDEX IF NOT EXISTS movies_tmdb_tv_season_identity_idx
  ON movies (tmdb_id, tmdb_season_number)
  WHERE tmdb_id IS NOT NULL AND tmdb_media_type = 'tv' AND tmdb_season_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS movies_tmdb_image_pending_idx
  ON movies (tmdb_identity_status, tmdb_image_checked_at)
  WHERE tmdb_identity_status IN ('pending', 'retry');
