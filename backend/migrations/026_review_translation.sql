-- Vietnamese machine translation of stored TMDB reviews.
--
-- content stays the English source of truth (spoiler flag and score are computed
-- from it). content_vi is only trustworthy while translated_hash equals the
-- current content_hash: a TMDB refresh that rewrites content leaves the old
-- translation in place but the API stops serving it until the worker
-- retranslates. content_vi = '' means "translated, nothing worth showing"
-- (provider echoed the source), so the row leaves the queue without a value.
-- translate_retry_at backs a single failing review off without blocking the rest.
ALTER TABLE movie_reviews ADD COLUMN IF NOT EXISTS content_vi text;
ALTER TABLE movie_reviews ADD COLUMN IF NOT EXISTS translated_hash text;
ALTER TABLE movie_reviews ADD COLUMN IF NOT EXISTS translated_at timestamptz;
ALTER TABLE movie_reviews ADD COLUMN IF NOT EXISTS translate_failed_at timestamptz;
ALTER TABLE movie_reviews ADD COLUMN IF NOT EXISTS translate_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS movie_reviews_translate_pending_idx
  ON movie_reviews (created_at, id)
  WHERE content_vi IS NULL OR translated_hash IS DISTINCT FROM content_hash;
