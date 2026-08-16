DROP INDEX IF EXISTS movies_imdb_identity_idx;

CREATE UNIQUE INDEX IF NOT EXISTS movies_imdb_identity_idx
  ON movies (imdb_id, media_type)
  WHERE imdb_id IS NOT NULL AND tmdb_season_number IS NULL;
