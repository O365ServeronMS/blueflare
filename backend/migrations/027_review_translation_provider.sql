-- Which provider produced content_vi (google-gtx, gemini). Internal only, never
-- exposed by the API; NULL for rows translated before this column existed.
ALTER TABLE movie_reviews ADD COLUMN IF NOT EXISTS translate_provider text;
