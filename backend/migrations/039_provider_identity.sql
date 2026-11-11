-- Provider TMDB/IMDb ids (backend/src/providerIdentity.js, providerIdentitySync.js).
--
-- tmdb_identity_pinned: a person (or the catalog audit gate) settled this row's identity; the
-- provider pass never rewrites it and only reports. Set by catalog audit applies, by
-- undoTmdbIdentity, and by any assignTmdbIdentity caller passing pin: true (manual batches). Nullable on purpose: movie_merges snapshots taken
-- before this column existed are re-inserted by undo through jsonb_populate_record.
ALTER TABLE movies ADD COLUMN IF NOT EXISTS tmdb_identity_pinned boolean;

-- One row per canonical movie the provider pass has decided on. `claims_key` fingerprints what
-- the providers claim plus the row's own tuple and the pass mode: an unchanged fingerprint is
-- skipped, so undecidable rows do not cost TMDB calls every cycle.
--   status pending   waiting for the AI match (reason in AI set) or the catalog audit (seasons)
--          planned   dry-run, or the tier is not enabled yet
--          done      applied, nothing to do, or settled by the AI match / audit (`outcome`)
--          blocked   pinned, guard refused, conflict; reported, retried when claims change
-- Disposable: wiping it only makes the pass re-decide every row once.
CREATE TABLE IF NOT EXISTS provider_identity_reviews (
  movie_id uuid PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
  claims_key text NOT NULL,
  action text NOT NULL,
  reason text,
  tier text,
  status text NOT NULL CHECK (status IN ('pending', 'planned', 'done', 'blocked')),
  outcome text,
  candidates jsonb,
  claims jsonb,
  decided_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS provider_identity_reviews_pending_idx
  ON provider_identity_reviews (reason, decided_at) WHERE status = 'pending';

-- List-page walk that refreshes the ids stored on every provider record (lane 'provider-ids').
ALTER TABLE crawl_checkpoints DROP CONSTRAINT IF EXISTS crawl_checkpoints_lane_check;
ALTER TABLE crawl_checkpoints
  ADD CONSTRAINT crawl_checkpoints_lane_check CHECK (lane IN ('backfill', 'image-heal', 'provider-ids'));
