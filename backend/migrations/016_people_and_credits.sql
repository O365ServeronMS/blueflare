-- People and movie<->person edges, both keyed by TMDB ids rather than by the
-- provider name strings in movies.actors/movies.directors. Those strings carry
-- placeholders ('Dang cap nhat'), undecoded HTML entities and Han-Viet
-- transliterations of the same person, so they cannot key anything.
--
-- Edges are keyed by the TMDB identity exactly like tmdb_recommendations: every
-- season row of a series shares one identity, so one fetch serves all of them,
-- and a title synced later joins in at read time without a refetch.
CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_person_id bigint NOT NULL UNIQUE CHECK (tmdb_person_id > 0),
  name text NOT NULL,
  -- Permalink. Written once, never recomputed on read: TMDB renames people.
  slug text NOT NULL UNIQUE,
  profile_asset_id uuid REFERENCES image_assets(id),
  profile_source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS movie_credits (
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('cast', 'director')),
  -- 'character' is a PostgreSQL type keyword; the column is named around it.
  character_name text,
  ord integer NOT NULL DEFAULT 0,
  -- Only 'verified' is written today. The column exists so guessed lookup ids
  -- can be admitted later and filtered at display time, without a migration.
  confidence text NOT NULL DEFAULT 'verified' CHECK (confidence IN ('verified', 'guessed')),
  PRIMARY KEY (media_type, tmdb_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS movie_credits_person_idx
  ON movie_credits (person_id, role, ord);

CREATE TABLE IF NOT EXISTS tmdb_credits_sync (
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  status text NOT NULL CHECK (status IN ('ok', 'empty', 'not_found', 'error')),
  last_error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_type, tmdb_id)
);

-- The person page joins credits back to movies on (tmdb_id, tmdb_media_type)
-- with the media type as a bound parameter, so the existing partial indexes
-- (WHERE tmdb_media_type = 'movie' / 'tv') are not provable at plan time.
CREATE INDEX IF NOT EXISTS movies_tmdb_identity_lookup_idx
  ON movies (tmdb_id, tmdb_media_type)
  WHERE tmdb_id IS NOT NULL;
