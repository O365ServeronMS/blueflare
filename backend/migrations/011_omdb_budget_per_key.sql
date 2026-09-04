-- Track the daily OMDb allowance per key instead of globally.
--
-- OMDb's free tier caps a *key* at 1000 requests per UTC day, not an account,
-- so holding several keys multiplies the ceiling. The counter therefore has to
-- be per key: one shared counter would stop the whole pass as soon as the first
-- key's worth of requests had been spent, no matter how many keys were left.
--
-- `key_id` is a truncated SHA-256 of the key, never the key itself. This table
-- ends up in the nightly dump that is shipped to offsite object storage, and a
-- credential has no business travelling with it. The hash is stable, so a key
-- keeps its budget row across restarts and across a reordering of
-- OMDB_API_KEYS.
--
-- Rows written before this migration were counted against a single key that
-- cannot be identified from SQL, so they are attributed to 'legacy'. The effect
-- is that today's already-spent requests are not charged to that key's new row:
-- worst case it is allowed its full allowance again today, for a same-day total
-- of used + (OMDB_DAILY_BUDGET - OMDB_BUDGET_RESERVE). With the default reserve
-- of 50 that stays under 1000, which is exactly what the reserve is for.

ALTER TABLE omdb_budget ADD COLUMN IF NOT EXISTS key_id text NOT NULL DEFAULT 'legacy';

ALTER TABLE omdb_budget DROP CONSTRAINT IF EXISTS omdb_budget_pkey;
ALTER TABLE omdb_budget ADD PRIMARY KEY (day, key_id);
