-- Daily liveness verdict per image source host (worker writes, api/worker read).
-- 'dead' hosts are dropped from the effective IMAGE_ALLOWED_HOSTS; delete the row
-- to reset a host to unknown.
CREATE TABLE IF NOT EXISTS image_host_health (
  host text PRIMARY KEY,
  status text NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'dead')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  dead_since timestamptz,
  last_detail text
);
