-- TMDB recommendation id lists, keyed by the TMDB identity rather than by a
-- catalog row: every season of a series shares one list, so one fetch serves
-- all of them. Only ids are stored; they are matched to playable catalog rows
-- at read time, so titles synced later appear without a refetch.
CREATE TABLE IF NOT EXISTS tmdb_recommendations (
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  recommended_ids bigint[] NOT NULL DEFAULT '{}',
  similar_ids bigint[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('ok', 'empty', 'not_found', 'error')),
  last_error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_type, tmdb_id)
);

-- Read-time matching looks recommended ids up through the two guessed-id
-- columns as well as tmdb_id; neither had an index usable for that.
CREATE INDEX IF NOT EXISTS movies_tmdb_lookup_id_idx
  ON movies (tmdb_lookup_id)
  WHERE tmdb_id IS NULL AND tmdb_lookup_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movies_tmdb_image_fallback_id_idx
  ON movies (tmdb_image_fallback_id)
  WHERE tmdb_id IS NULL AND tmdb_image_fallback_id IS NOT NULL;
