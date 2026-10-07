-- Audit and undo log for TMDB identity assignment (backend/src/tmdbIdentity.js). One row per
-- decision that touched, or deliberately declined to touch, a title:
--   assign   a tmdb_id/media type/season was written onto a row nobody else held
--   merge    the row already held by another title was folded into one survivor; `merge_id`
--            points at the movie_merges snapshot (dropped row, moved sources, favorites, history)
--            and `meta` carries what that snapshot lacks (user rows inserted, reviews moved, ...)
--   blocked  the identity could not be applied safely (season unknown, provider id differs)
--   conflict a unique index refused the write; nothing changed
-- blocked/conflict rows also stop the promotion queue from retrying the same title every
-- cycle. movie_id has no foreign key on purpose: the log must outlive a dropped row.
CREATE TABLE IF NOT EXISTS tmdb_identity_changes (
  id bigserial PRIMARY KEY,
  movie_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assign', 'merge', 'blocked', 'conflict')),
  source text,
  tmdb_id bigint,
  media_type text,
  season integer,
  reason text,
  evidence jsonb,
  before jsonb,
  merge_id bigint,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS tmdb_identity_changes_movie_idx ON tmdb_identity_changes (movie_id, created_at DESC);
