-- The quota ledger now serves OpenRouter only (backend/src/aiQuotaLedger.js); the table was created as gemini_quota_ledger (031).
-- Disposable data: a missing/empty ledger only resets the day's counts until the provider answers 429.
ALTER TABLE IF EXISTS gemini_quota_ledger RENAME TO ai_quota_ledger;
ALTER INDEX IF EXISTS gemini_quota_ledger_day_idx RENAME TO ai_quota_ledger_day_idx;
