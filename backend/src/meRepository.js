import { pool } from './db.js';
import { MAX_SESSIONS_PER_USER } from './auth.js';

// Every function here is a plain per-user read or write. None of it goes through
// Valkey and none of it calls a provider.

const READY = "m.catalog_state='ready'";

export async function createUser(email, passwordHash) {
  try {
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') return null;
    throw error;
  }
}

export async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT id, email, password_hash FROM users WHERE lower(email)=$1',
    [email]
  );
  return result.rows[0] || null;
}

export async function createSession(userId, tokenHash, expiresAt) {
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
  // Housekeeping on the write path: expired rows and anything beyond the newest
  // MAX_SESSIONS_PER_USER for this user.
  await pool.query(
    'DELETE FROM sessions WHERE user_id=$1 AND (expires_at < now() OR id IN (' +
    'SELECT id FROM sessions WHERE user_id=$1 ORDER BY created_at DESC OFFSET $2))',
    [userId, MAX_SESSIONS_PER_USER]
  );
}

export async function findSession(tokenHash) {
  const result = await pool.query(
    'SELECT s.id, s.expires_at, s.renewed_at, u.id AS user_id, u.email, u.imported_at ' +
    'FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1',
    [tokenHash]
  );
  return result.rows[0] || null;
}

export async function renewSession(sessionId, expiresAt) {
  await pool.query(
    'UPDATE sessions SET expires_at=$2, renewed_at=now() WHERE id=$1',
    [sessionId, expiresAt]
  );
}

export async function deleteSession(tokenHash) {
  await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
}

export async function listFavorites(userId, limit = 500) {
  const result = await pool.query(
    'SELECT m.canonical_slug AS slug, f.created_at AS at FROM user_favorites f ' +
    'JOIN movies m ON m.id=f.movie_id ' +
    'WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

/** false when the slug is not a ready title. */
export async function addFavorite(userId, slug) {
  const result = await pool.query(
    'INSERT INTO user_favorites (user_id, movie_id) ' +
    'SELECT $1, m.id FROM movies m WHERE m.canonical_slug=$2 AND ' + READY + ' ' +
    'ON CONFLICT DO NOTHING RETURNING movie_id',
    [userId, slug]
  );
  if (result.rows.length) return true;
  return movieExists(slug);
}

export async function movieExists(slug) {
  const result = await pool.query(
    'SELECT 1 FROM movies m WHERE m.canonical_slug=$1 AND ' + READY,
    [slug]
  );
  return result.rows.length > 0;
}

export async function removeFavorite(userId, slug) {
  await pool.query(
    'DELETE FROM user_favorites WHERE user_id=$1 AND movie_id=' +
    '(SELECT id FROM movies WHERE canonical_slug=$2)',
    [userId, slug]
  );
}

/**
 * Upsert the single progress row for (user, movie). The WHERE clause makes an
 * older write a no-op, so a delayed beacon cannot rewind newer progress.
 * Returns false when the slug is not a ready title.
 */
export async function upsertProgress(userId, slug, progress) {
  const result = await pool.query(
    'INSERT INTO user_watch_progress ' +
    '(user_id, movie_id, episode_key, position_sec, duration_sec, completed, updated_at) ' +
    'SELECT $1, m.id, $3, $4, $5, $6, $7 FROM movies m WHERE m.canonical_slug=$2 AND ' + READY + ' ' +
    'ON CONFLICT (user_id, movie_id) DO UPDATE SET ' +
    'episode_key=EXCLUDED.episode_key, position_sec=EXCLUDED.position_sec, ' +
    'duration_sec=EXCLUDED.duration_sec, completed=EXCLUDED.completed, updated_at=EXCLUDED.updated_at ' +
    'WHERE user_watch_progress.updated_at <= EXCLUDED.updated_at ' +
    'RETURNING movie_id',
    [
      userId, slug, progress.episodeKey, progress.positionSec, progress.durationSec,
      progress.completed, progress.at
    ]
  );
  if (result.rows.length) return true;
  // Empty means an older write was ignored, or the movie is unknown.
  return movieExists(slug);
}

export async function deleteProgress(userId, slug) {
  await pool.query(
    'DELETE FROM user_watch_progress WHERE user_id=$1 AND movie_id=' +
    '(SELECT id FROM movies WHERE canonical_slug=$2)',
    [userId, slug]
  );
}

/** Newest first; over-fetches so the JS filter can still fill 20 cards. */
export async function listContinueRows(userId, limit = 60) {
  const result = await pool.query(
    'SELECT m.*, p.episode_key AS p_episode_key, p.position_sec AS p_position_sec, ' +
    'p.duration_sec AS p_duration_sec, p.completed AS p_completed, p.updated_at AS p_updated_at ' +
    'FROM user_watch_progress p JOIN movies m ON m.id=p.movie_id ' +
    'WHERE p.user_id=$1 AND ' + READY + " AND m.canonical_slug<>'' " +
    'ORDER BY p.updated_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

/** movie id -> streams arrays, ordered by provider priority. */
export async function streamsForMovies(movieIds) {
  const byMovie = new Map();
  if (!movieIds.length) return byMovie;
  const result = await pool.query(
    'SELECT movie_id, streams FROM movie_provider_sources ' +
    'WHERE movie_id = ANY($1::uuid[]) AND availability=true ORDER BY priority ASC, provider ASC',
    [movieIds]
  );
  for (const row of result.rows) {
    if (!byMovie.has(row.movie_id)) byMovie.set(row.movie_id, []);
    if (Array.isArray(row.streams)) byMovie.get(row.movie_id).push(...row.streams);
  }
  return byMovie;
}

export async function listHistory(userId, limit = 100) {
  const result = await pool.query(
    'SELECT m.canonical_slug AS slug, h.watched_at AS at FROM user_history h ' +
    'JOIN movies m ON m.id=h.movie_id ' +
    "WHERE h.user_id=$1 AND m.canonical_slug<>'' ORDER BY h.watched_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows;
}

export async function touchHistory(userId, slug) {
  const result = await pool.query(
    'INSERT INTO user_history (user_id, movie_id, watched_at) ' +
    'SELECT $1, m.id, now() FROM movies m WHERE m.canonical_slug=$2 AND ' + READY + ' ' +
    'ON CONFLICT (user_id, movie_id) DO UPDATE SET watched_at=now() RETURNING movie_id',
    [userId, slug]
  );
  return result.rows.length > 0;
}

/**
 * Merge localStorage data. `favorites` and `history` are already validated,
 * de-duplicated and capped: [{ slug, at: Date }]. Runs in one transaction and
 * is safe to repeat: favorites keep their first savedAt, history keeps the
 * newest watchedAt. Returns how many slugs were known per list.
 */
export async function importUserData(userId, favorites, history) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = { favorites: 0, history: 0 };
    if (favorites.length) {
      const result = await client.query(
        'INSERT INTO user_favorites (user_id, movie_id, created_at) ' +
        'SELECT $1, m.id, i.at FROM unnest($2::text[], $3::timestamptz[]) AS i(slug, at) ' +
        'JOIN movies m ON m.canonical_slug=i.slug AND ' + READY + ' ' +
        'ON CONFLICT (user_id, movie_id) DO UPDATE SET user_id=user_favorites.user_id ' +
        'RETURNING movie_id',
        [userId, favorites.map((item) => item.slug), favorites.map((item) => item.at)]
      );
      counts.favorites = result.rows.length;
    }
    if (history.length) {
      const result = await client.query(
        'INSERT INTO user_history (user_id, movie_id, watched_at) ' +
        'SELECT $1, m.id, i.at FROM unnest($2::text[], $3::timestamptz[]) AS i(slug, at) ' +
        'JOIN movies m ON m.canonical_slug=i.slug AND ' + READY + ' ' +
        'ON CONFLICT (user_id, movie_id) DO UPDATE SET ' +
        'watched_at=GREATEST(user_history.watched_at, EXCLUDED.watched_at) ' +
        'RETURNING movie_id',
        [userId, history.map((item) => item.slug), history.map((item) => item.at)]
      );
      counts.history = result.rows.length;
    }
    await client.query(
      'UPDATE users SET imported_at=COALESCE(imported_at, now()) WHERE id=$1',
      [userId]
    );
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
