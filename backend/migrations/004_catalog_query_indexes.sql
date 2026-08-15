-- Phase 4: indexes matching the canonical catalog read paths.
-- Apply during a maintenance window on a large catalog because CREATE INDEX
-- takes a table lock in the current migration runner.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS movies_year_type_idx
  ON movies (year, media_type);

CREATE INDEX IF NOT EXISTS movies_ready_media_sort_idx
  ON movies (media_type, catalog_sort_at DESC NULLS LAST, year DESC NULLS LAST, canonical_slug)
  WHERE catalog_state = 'ready';

CREATE INDEX IF NOT EXISTS movies_ready_display_sort_idx
  ON movies (display_type, catalog_sort_at DESC NULLS LAST, year DESC NULLS LAST, canonical_slug)
  WHERE catalog_state = 'ready';

CREATE INDEX IF NOT EXISTS movies_ready_genres_gin_idx
  ON movies USING gin (genres jsonb_path_ops)
  WHERE catalog_state = 'ready';

CREATE INDEX IF NOT EXISTS movies_ready_countries_gin_idx
  ON movies USING gin (countries jsonb_path_ops)
  WHERE catalog_state = 'ready';

CREATE INDEX IF NOT EXISTS movies_ready_normalized_title_trgm_idx
  ON movies USING gin (normalized_title gin_trgm_ops)
  WHERE catalog_state = 'ready';

CREATE INDEX IF NOT EXISTS movies_ready_normalized_original_title_trgm_idx
  ON movies USING gin (normalized_original_title gin_trgm_ops)
  WHERE catalog_state = 'ready' AND normalized_original_title IS NOT NULL;
