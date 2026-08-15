CREATE TABLE IF NOT EXISTS movies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_slug text NOT NULL UNIQUE,
  title text NOT NULL,
  original_title text,
  normalized_title text NOT NULL,
  normalized_original_title text,
  media_type text NOT NULL,
  display_type text,
  year integer,
  tmdb_id bigint,
  imdb_id text,
  overview text,
  thumb_source_url text,
  poster_source_url text,
  quality text,
  language text,
  status text,
  episode_current text,
  episode_total text,
  duration text,
  actors jsonb NOT NULL DEFAULT '[]'::jsonb,
  directors jsonb NOT NULL DEFAULT '[]'::jsonb,
  genres jsonb NOT NULL DEFAULT '[]'::jsonb,
  countries jsonb NOT NULL DEFAULT '[]'::jsonb,
  ratings jsonb NOT NULL DEFAULT '{}'::jsonb,
  primary_provider text NOT NULL DEFAULT 'nguonc',
  provider_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS movies_tmdb_identity_idx
  ON movies (tmdb_id, media_type)
  WHERE tmdb_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS movies_imdb_identity_idx
  ON movies (imdb_id, media_type)
  WHERE imdb_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS movies_original_year_type_idx
  ON movies (normalized_original_title, year, media_type);

CREATE INDEX IF NOT EXISTS movies_title_year_type_idx
  ON movies (normalized_title, year, media_type);

CREATE INDEX IF NOT EXISTS movies_updated_idx
  ON movies (provider_updated_at DESC NULLS LAST, updated_at DESC);

CREATE TABLE IF NOT EXISTS movie_provider_sources (
  id bigserial PRIMARY KEY,
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_movie_id text NOT NULL,
  provider_slug text NOT NULL,
  priority integer NOT NULL,
  availability boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL,
  streams jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_updated_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_movie_id),
  UNIQUE (provider, provider_slug)
);
CREATE INDEX IF NOT EXISTS movie_provider_sources_movie_idx
  ON movie_provider_sources (movie_id, priority, provider);

CREATE TABLE IF NOT EXISTS provider_health (
  provider text PRIMARY KEY,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_latency_ms integer,
  last_http_status integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  parse_failures bigint NOT NULL DEFAULT 0,
  schema_drift_failures bigint NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
