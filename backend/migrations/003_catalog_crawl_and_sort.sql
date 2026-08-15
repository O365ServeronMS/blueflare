ALTER TABLE movies
  ADD COLUMN IF NOT EXISTS catalog_state text NOT NULL DEFAULT 'ready'
    CHECK (catalog_state IN ('draft', 'ready', 'unavailable')),
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS catalog_sort_at timestamptz;

UPDATE movies
  SET catalog_sort_at = provider_updated_at
  WHERE catalog_sort_at IS NULL AND provider_updated_at IS NOT NULL;

UPDATE movies
  SET ready_at = COALESCE(ready_at, created_at)
  WHERE catalog_state = 'ready';

CREATE INDEX IF NOT EXISTS movies_catalog_ready_sort_idx
  ON movies (catalog_sort_at DESC NULLS LAST, year DESC NULLS LAST, canonical_slug)
  WHERE catalog_state = 'ready';

CREATE TABLE IF NOT EXISTS crawl_checkpoints (
  provider text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('backfill')),
  next_page integer NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  last_page_hash text,
  total_pages integer,
  completed_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, lane)
);

UPDATE movie_provider_sources source
  SET metadata = jsonb_strip_nulls(jsonb_build_object(
    'source_id', source.provider_movie_id,
    'source_slug', source.provider_slug,
    'source_updated_at', source.provider_updated_at,
    'title', movie.title,
    'original_title', movie.original_title,
    'year', movie.year,
    'type', movie.display_type,
    'quality', movie.quality,
    'language', movie.language,
    'status', movie.status,
    'episode_current', movie.episode_current,
    'episode_total', movie.episode_total,
    'thumb_source_url', movie.thumb_source_url,
    'poster_source_url', movie.poster_source_url
  ))
  FROM movies movie
  WHERE movie.id = source.movie_id;
