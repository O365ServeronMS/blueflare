-- MDBList full-catalog backfill: a uuid cursor on the movies walk, stored on
-- the existing crawl_checkpoints table under provider='mdblist', lane='backfill'.
-- next_page stays 1/unused for this lane (its CHECK requires >= 1); next_cursor
-- holds the last processed
-- movies.id so the walk resumes across cycles and restarts.
ALTER TABLE crawl_checkpoints ADD COLUMN IF NOT EXISTS next_cursor text;

-- Lets the backfill walk skip the ~77% of rows with no tmdb/imdb id cheaply
-- while paging by id past the cursor.
CREATE INDEX IF NOT EXISTS movies_mdblist_backfill_idx
  ON movies (id)
  WHERE catalog_state = 'ready' AND (tmdb_id IS NOT NULL OR imdb_id IS NOT NULL);
