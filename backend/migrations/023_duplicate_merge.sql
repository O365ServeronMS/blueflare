-- Merging a NguonC-only row into the KKPhim row that describes the same work.
--
-- movie_slug_aliases keeps the dropped row's canonical slug resolvable (old links,
-- guest favorites in localStorage). movie_merges snapshots everything the merge
-- deletes or moves, so a merge can be undone by hand. movie_merges has no foreign
-- key to movies: the audit row must outlive both rows.
CREATE TABLE IF NOT EXISTS movie_slug_aliases (
  slug text PRIMARY KEY,
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movie_slug_aliases_movie_idx ON movie_slug_aliases (movie_id);

CREATE TABLE IF NOT EXISTS movie_merges (
  id bigserial PRIMARY KEY,
  kept_movie_id uuid NOT NULL,
  kept_slug text NOT NULL,
  dropped_movie_id uuid NOT NULL,
  dropped_slug text NOT NULL,
  dropped_row jsonb NOT NULL,
  kept_row_before jsonb NOT NULL,
  moved_source_ids bigint[] NOT NULL,
  favorites jsonb NOT NULL DEFAULT '[]'::jsonb,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  hero jsonb NOT NULL DEFAULT '[]'::jsonb,
  merged_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movie_merges_kept_idx ON movie_merges (kept_movie_id);
