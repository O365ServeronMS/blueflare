-- Catalog audit memory: a group the model answered with no action, or only actions the gate refused,
-- is keyed by the hash of its input so the next run need not ask again. Disposable: wiping it only
-- makes the audit ask the model again. Additive and idempotent, so the previous image still runs.
CREATE TABLE IF NOT EXISTS catalog_audit_group_memory (
  group_hash text PRIMARY KEY,
  group_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('none', 'blocked')),
  run_id bigint NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
