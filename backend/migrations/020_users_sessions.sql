-- Accounts, sessions and per-user watch state (PLAN-006).
--
-- Email uniqueness is a lower(email) unique index over a plain text column
-- instead of citext: the app always stores the normalized (trimmed, lowercased)
-- address, and the index keeps that true even if a future writer forgets,
-- without depending on a contrib extension being installable at boot.
--
-- Sessions store only the sha256 of the bearer token, so a database read (or a
-- backup leak) cannot be replayed as a login.
--
-- Everything here is new tables, so a rolling restart with the previous api
-- image still serving is safe.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set once by POST /api/me/import; null means localStorage was not merged yet.
  imported_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- Sliding expiry is written at most once an hour; this is the last write.
  renewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS user_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, movie_id)
);

CREATE INDEX IF NOT EXISTS user_favorites_recent_idx
  ON user_favorites (user_id, created_at DESC);

-- One row per (user, movie): the most recent episode only.
CREATE TABLE IF NOT EXISTS user_watch_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  episode_key text NOT NULL,
  position_sec integer NOT NULL CHECK (position_sec >= 0),
  duration_sec integer NOT NULL CHECK (duration_sec > 0),
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, movie_id)
);

CREATE INDEX IF NOT EXISTS user_watch_progress_recent_idx
  ON user_watch_progress (user_id, updated_at DESC);

-- Watch history, including iframe titles that have no measurable progress.
CREATE TABLE IF NOT EXISTS user_history (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  watched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, movie_id)
);

CREATE INDEX IF NOT EXISTS user_history_recent_idx
  ON user_history (user_id, watched_at DESC);
