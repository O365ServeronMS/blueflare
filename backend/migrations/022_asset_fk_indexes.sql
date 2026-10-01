-- Indexes on the referencing side of every foreign key into image_assets(id).
--
-- movies.thumb_asset_id and movies.poster_asset_id already had one. The other
-- three did not, so deleting an image_assets row forced a sequential scan of
-- movies/people for each FK check, and "NOT EXISTS (... OR ...)" orphan probes
-- could not use an index either. The dead-host purge ran for hours at 100% CPU.
-- Partial indexes: only non-NULL values can ever be referenced.
CREATE INDEX IF NOT EXISTS movies_tmdb_thumb_asset_idx
  ON movies (tmdb_thumb_asset_id) WHERE tmdb_thumb_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movies_tmdb_poster_asset_idx
  ON movies (tmdb_poster_asset_id) WHERE tmdb_poster_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS people_profile_asset_idx
  ON people (profile_asset_id) WHERE profile_asset_id IS NOT NULL;
