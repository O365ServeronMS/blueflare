-- Rotten Tomatoes critic and audience scores sourced exclusively from MDBList.
--
-- Keep these columns separate from both provider-owned `ratings` JSONB and the
-- OMDb columns. NguonC/KKPhim rewrites the JSONB during normal syncs, while the
-- independent columns let OMDb be disabled or re-enabled without changing what
-- MDBList supplied to the two visible badges.

ALTER TABLE movies ADD COLUMN IF NOT EXISTS mdblist_status text NOT NULL DEFAULT 'none';
ALTER TABLE movies ADD COLUMN IF NOT EXISTS mdblist_checked_at timestamptz;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS mdblist_tomatoes smallint;
ALTER TABLE movies ADD COLUMN IF NOT EXISTS mdblist_audience smallint;

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_mdblist_status_check;
ALTER TABLE movies ADD CONSTRAINT movies_mdblist_status_check CHECK (
  mdblist_status IN ('none', 'matched', 'partial', 'unmatched', 'no-id', 'error')
);

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_mdblist_tomatoes_check;
ALTER TABLE movies ADD CONSTRAINT movies_mdblist_tomatoes_check CHECK (
  mdblist_tomatoes IS NULL OR mdblist_tomatoes BETWEEN 0 AND 100
);

ALTER TABLE movies DROP CONSTRAINT IF EXISTS movies_mdblist_audience_check;
ALTER TABLE movies ADD CONSTRAINT movies_mdblist_audience_check CHECK (
  mdblist_audience IS NULL OR mdblist_audience BETWEEN 0 AND 100
);

-- Demand-driven candidate selection starts with unchecked visible rows. Error
-- rows remain eligible on a short TTL; genuine misses use the slower miss TTL.
CREATE INDEX IF NOT EXISTS movies_mdblist_pending_idx
  ON movies (mdblist_checked_at NULLS FIRST)
  WHERE catalog_state = 'ready';

-- MDBList reports a per-key request limit that resets at 00:00 UTC. Postgres is
-- canonical for this counter because Valkey eviction must never reset quota.
-- `key_id` is a short SHA-256 identity, not the credential itself.
CREATE TABLE IF NOT EXISTS mdblist_budget (
  day date NOT NULL,
  key_id text NOT NULL,
  used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, key_id)
);
