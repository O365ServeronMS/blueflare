-- Completion (output) tokens per key+model+day, so a daily output cap can apply to paid models only.
-- Disposable like the rest of the ledger: rows from before this column count 0 output.
ALTER TABLE ai_quota_ledger ADD COLUMN IF NOT EXISTS output_tokens bigint NOT NULL DEFAULT 0;
