-- Review translation was removed (browsers translate the page themselves). Drop the columns and
-- index added by 026/027. Reviews keep the English source of truth and are re-fetchable from TMDB.
ALTER TABLE movie_reviews
  DROP COLUMN IF EXISTS content_vi,
  DROP COLUMN IF EXISTS translated_hash,
  DROP COLUMN IF EXISTS translated_at,
  DROP COLUMN IF EXISTS translate_failed_at,
  DROP COLUMN IF EXISTS translate_retry_at,
  DROP COLUMN IF EXISTS translate_provider;
