ALTER TABLE provider_health
  ADD COLUMN IF NOT EXISTS schema_drift_failures bigint NOT NULL DEFAULT 0;
