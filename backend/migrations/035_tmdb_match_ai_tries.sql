-- AI match attempt cap (tmdbMatchAiSync.js): every run stores the metadata it saw as
-- meta_key = md5(title|original_title|year). A title with MAX_REAL_TRIES (3) 'none'/'unverifiable'
-- runs on its current meta_key is no longer listed; a changed title, original title or year
-- gives a new key, which reopens it (and lifts the retry wait). Old runs take the row's current
-- key: they are counted as if the metadata had not changed since.
ALTER TABLE tmdb_match_ai_runs ADD COLUMN IF NOT EXISTS meta_key text;
UPDATE tmdb_match_ai_runs r
SET meta_key = md5(coalesce(m.title, '') || '|' || coalesce(m.original_title, '') || '|' || coalesce(m.year::text, ''))
FROM movies m
WHERE m.id = r.movie_id AND r.meta_key IS NULL;
