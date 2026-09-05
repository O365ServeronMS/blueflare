-- A TMDB id guessed from the title, used only as a lookup key for MDBList
-- ratings on rows that carry neither a tmdb_id nor an imdb_id.
--
-- It is deliberately a separate column: a title guess must never feed identity
-- resolution, because a wrong match there would merge two unrelated titles.
-- Wrong here costs one row a wrong score and is reversible by nulling it out.
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_lookup_id integer;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_lookup_status text;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_lookup_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS movies_tmdb_lookup_due_idx
  ON movies (tmdb_lookup_checked_at NULLS FIRST)
  WHERE catalog_state = 'ready' AND tmdb_id IS NULL AND imdb_id IS NULL;
