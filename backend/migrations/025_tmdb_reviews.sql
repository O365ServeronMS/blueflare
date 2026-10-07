-- TMDB user reviews for the detail page.
--
-- Unlike credits and recommendations these rows hang off the catalog row
-- (movie_id), not the TMDB identity: the review list is capped and scored per
-- page, and a merged or split row must keep its own set. `reviews_checked_at`
-- orders the worker queue (oldest first, NULL first); `reviews_next_retry_at`
-- is the single gate for when a row is due again, so a failed fetch backs off
-- without touching the success mark.
--
-- No avatar column on purpose: images are only the two image_assets variants.
CREATE TABLE IF NOT EXISTS movie_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  tmdb_review_id text NOT NULL,
  author text NOT NULL DEFAULT '',
  author_username text,
  rating numeric(3, 1) CHECK (rating IS NULL OR rating BETWEEN 0 AND 10),
  content text NOT NULL,
  tmdb_created_at timestamptz,
  tmdb_url text,
  has_spoiler boolean NOT NULL DEFAULT false,
  score numeric(5, 2) NOT NULL DEFAULT 0,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (movie_id, tmdb_review_id)
);

CREATE INDEX IF NOT EXISTS movie_reviews_order_idx
  ON movie_reviews (movie_id, has_spoiler DESC, score DESC);

ALTER TABLE movies ADD COLUMN IF NOT EXISTS reviews_checked_at timestamptz;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS reviews_next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS movies_reviews_pending_idx
  ON movies (reviews_checked_at NULLS FIRST)
  WHERE catalog_state = 'ready';
