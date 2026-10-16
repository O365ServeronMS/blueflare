-- Weekly catalog audit (backend/src/catalogAudit*.js). One row per pass in catalog_audit_runs,
-- one row per proposed action in catalog_audit_actions:
--   status   dry-run  the gate passed, mode was dry-run, nothing written
--            applied  written; `before` holds what undo puts back
--            blocked  the deterministic gate refused it (`gate` names why)
--            failed   apply threw; nothing written (transaction rolled back)
--            undone   reversed by backend/scripts/catalog-audit-undo.mjs
-- `identity_change_id` points at tmdb_identity_changes when the action went through
-- tmdbIdentity.js (season fix, merge); undo then goes through that log. No foreign keys to
-- movies on purpose: the log must outlive a dropped row.
CREATE TABLE IF NOT EXISTS catalog_audit_runs (
  id bigserial PRIMARY KEY,
  mode text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'partial', 'failed')),
  groups integer NOT NULL DEFAULT 0,
  summary jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS catalog_audit_runs_started_idx ON catalog_audit_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS catalog_audit_actions (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES catalog_audit_runs(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  detectors text[] NOT NULL DEFAULT '{}',
  action text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  status text NOT NULL CHECK (status IN ('dry-run', 'applied', 'blocked', 'failed', 'undone')),
  gate text,
  before jsonb,
  after jsonb,
  slugs text[] NOT NULL DEFAULT '{}',
  identity_change_id bigint,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS catalog_audit_actions_run_idx ON catalog_audit_actions (run_id, id);
