-- Persistent free-tier quota ledger for Gemini keys (backend/src/geminiQuotaLedger.js).
-- The binding limit is requests per day per key+model, counted on the Pacific calendar day
-- (quotas reset at 00:00 America/Los_Angeles). Keeping the count in memory lost it on every
-- worker restart/deploy, so the loop would re-spend a day that was already spent.
--   key_fp          first 12 hex of sha256(api key); the key itself is never stored
--   day             Pacific calendar day the counters belong to
--   requests        requests started that day, failed and timed-out ones included
--   recent_tokens   [[epoch_ms, prompt_tokens], ...] of the last minute, the TPM sliding window
-- Disposable: wiping it only makes the ledger count from zero until the provider answers 429.
CREATE TABLE IF NOT EXISTS gemini_quota_ledger (
  key_fp text NOT NULL,
  model text NOT NULL,
  day date NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  successes integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  recent_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_request_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_fp, model, day)
);
CREATE INDEX IF NOT EXISTS gemini_quota_ledger_day_idx ON gemini_quota_ledger (day);
