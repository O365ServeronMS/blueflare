CREATE TABLE IF NOT EXISTS image_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE movies ADD COLUMN IF NOT EXISTS thumb_asset_id uuid REFERENCES image_assets(id);
ALTER TABLE movies ADD COLUMN IF NOT EXISTS poster_asset_id uuid REFERENCES image_assets(id);

INSERT INTO image_assets (source_url)
SELECT DISTINCT source_url
FROM (
  SELECT thumb_source_url AS source_url FROM movies WHERE thumb_source_url IS NOT NULL
  UNION
  SELECT poster_source_url AS source_url FROM movies WHERE poster_source_url IS NOT NULL
) sources
ON CONFLICT (source_url) DO NOTHING;

UPDATE movies AS m SET thumb_asset_id = a.id
FROM image_assets AS a
WHERE m.thumb_source_url = a.source_url AND m.thumb_asset_id IS DISTINCT FROM a.id;

UPDATE movies AS m SET poster_asset_id = a.id
FROM image_assets AS a
WHERE m.poster_source_url = a.source_url AND m.poster_asset_id IS DISTINCT FROM a.id;

CREATE INDEX IF NOT EXISTS movies_thumb_asset_idx ON movies (thumb_asset_id);
CREATE INDEX IF NOT EXISTS movies_poster_asset_idx ON movies (poster_asset_id);
