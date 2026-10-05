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

export async function removeHistory(userId, slug) {
  await pool.query(
    'DELETE FROM user_history WHERE user_id=$1 AND movie_id=' +
    '(SELECT id FROM movies WHERE canonical_slug=$2)',
    [userId, slug]
  );
}

export async function clearHistory(userId) {
  await pool.query('DELETE FROM user_history WHERE user_id=$1', [userId]);
}

export async function listHistory(userId, limit = 100) {
  const result = await pool.query(
    'SELECT m.canonical_slug AS slug, h.watched_at AS at, h.server_name, h.episode_key, h.episode_name ' +
    'FROM user_history h JOIN movies m ON m.id=h.movie_id ' +
    "WHERE h.user_id=$1 AND m.canonical_slug<>'' ORDER BY h.watched_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows.map((row) => ({
    slug: row.slug,
    at: row.at,
    serverName: row.server_name ?? null,
    episodeKey: row.episode_key ?? null,
    episodeName: row.episode_name ?? null
  }));
}

/**
 * `ep` is { serverName, episodeKey, episodeName } or null. A plain touch (null)
 * keeps the episode already stored; a given ep replaces all three columns.
 */
export async function touchHistory(userId, slug, ep = null) {
  const result = await pool.query(
    'INSERT INTO user_history (user_id, movie_id, watched_at, server_name, episode_key, episode_name) ' +
    'SELECT $1, m.id, now(), $3, $4, $5 FROM movies m WHERE m.canonical_slug=$2 AND ' + READY + ' ' +
    'ON CONFLICT (user_id, movie_id) DO UPDATE SET watched_at=now(), ' +
    'server_name=CASE WHEN EXCLUDED.episode_key IS NOT NULL THEN EXCLUDED.server_name ELSE user_history.server_name END, ' +
    'episode_name=CASE WHEN EXCLUDED.episode_key IS NOT NULL THEN EXCLUDED.episode_name ELSE user_history.episode_name END, ' +
    'episode_key=COALESCE(EXCLUDED.episode_key, user_history.episode_key) ' +
    'RETURNING movie_id',
    [userId, slug, ep?.serverName ?? null, ep?.episodeKey ?? null, ep?.episodeName ?? null]
  );
  return result.rows.length > 0;
}

/**
 * Merge localStorage data. `favorites` and `history` are already validated,
 * de-duplicated and capped: [{ slug, at: Date, ep? }] (history ep = { serverName, episodeKey, episodeName }). Runs in one transaction and
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
      // The episode columns follow the newer watched_at; an older or equal
      // incoming row, or one without an episode, keeps what is stored.
      const result = await client.query(
        'INSERT INTO user_history (user_id, movie_id, watched_at, server_name, episode_key, episode_name) ' +
        'SELECT $1, m.id, i.at, i.server_name, i.episode_key, i.episode_name ' +
        'FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[]) ' +
        'AS i(slug, at, server_name, episode_key, episode_name) ' +
        'JOIN movies m ON m.canonical_slug=i.slug AND ' + READY + ' ' +
        'ON CONFLICT (user_id, movie_id) DO UPDATE SET ' +
        'server_name=CASE WHEN EXCLUDED.watched_at > user_history.watched_at AND EXCLUDED.episode_key IS NOT NULL ' +
        'THEN EXCLUDED.server_name ELSE user_history.server_name END, ' +
        'episode_name=CASE WHEN EXCLUDED.watched_at > user_history.watched_at AND EXCLUDED.episode_key IS NOT NULL ' +
        'THEN EXCLUDED.episode_name ELSE user_history.episode_name END, ' +
        'episode_key=CASE WHEN EXCLUDED.watched_at > user_history.watched_at AND EXCLUDED.episode_key IS NOT NULL ' +
        'THEN EXCLUDED.episode_key ELSE user_history.episode_key END, ' +
        'watched_at=GREATEST(user_history.watched_at, EXCLUDED.watched_at) ' +
        'RETURNING movie_id',
        [
          userId,
          history.map((item) => item.slug),
          history.map((item) => item.at),
          history.map((item) => item.ep?.serverName ?? null),
          history.map((item) => item.ep?.episodeKey ?? null),
          history.map((item) => item.ep?.episodeName ?? null)
        ]
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

// ---- admin (read/moderate accounts; never returns password hashes) ---------

function likePattern(q) {
  return '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

export async function adminOverview() {
  const result = await pool.query(
    'SELECT (SELECT count(*) FROM users)::int AS users, ' +
    "(SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_7d, " +
    '(SELECT count(*) FROM sessions WHERE expires_at > now())::int AS active_sessions'
  );
  return result.rows[0];
}

export async function adminListUsers({ q = '', limit = 25, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (q) { params.push(likePattern(q)); where = ` WHERE u.email ILIKE $${params.length} ESCAPE '\\'`; }
  const total = await pool.query('SELECT count(*)::int AS n FROM users u' + where, params);
  params.push(limit, offset);
  const rows = await pool.query(
    'SELECT u.id, u.email, u.created_at, ' +
    '(SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.expires_at > now()) AS sessions, ' +
    '(SELECT max(s.renewed_at) FROM sessions s WHERE s.user_id=u.id) AS last_active, ' +
    '(SELECT count(*)::int FROM user_favorites f WHERE f.user_id=u.id) AS favorites, ' +
    '(SELECT count(*)::int FROM user_history h WHERE h.user_id=u.id) AS history ' +
    'FROM users u' + where + ` ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { total: total.rows[0].n, rows: rows.rows };
}

export async function adminFindUser(userId) {
  const result = await pool.query('SELECT id, email FROM users WHERE id=$1', [userId]);
  return result.rows[0] || null;
}

export async function adminRevokeSessions(userId) {
  const result = await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  return result.rowCount;
}

export async function adminDeleteUser(userId) {
  const result = await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  return result.rowCount > 0;
}
