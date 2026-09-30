-- Last watched episode per (user, movie) (PLAN-007). Replaces watch progress.
--
-- The player is a cross-origin iframe, so currentTime was never readable and
-- user_watch_progress stayed empty. What the site can know is which episode on
-- which server the user pressed Play on. user_history already has one row per
-- (user, movie), so the episode identity lives there. NULL means a movie without
-- episodes or a history row written before this migration.
--
-- Adding nullable columns is safe while the previous api image still serves.
-- The DROP is not reversible; the table held no rows in production.
ALTER TABLE user_history
  ADD COLUMN IF NOT EXISTS server_name text,
  ADD COLUMN IF NOT EXISTS episode_key text,
  ADD COLUMN IF NOT EXISTS episode_name text;

DROP TABLE IF EXISTS user_watch_progress;
