import {
  FailureTracker,
  RateLimiter,
  assessSession,
  bearerToken,
  dummyVerify,
  failureDelayMs,
  hashPassword,
  hashToken,
  newToken,
  normalizeEmail,
  sessionExpiry,
  validEmail,
  validPassword,
  verifyPassword,
  PASSWORD_MAX
} from './auth.js';
import * as meRepository from './meRepository.js';
import { card } from './viewmodels.js';

export const BODY_LIMIT_BYTES = 32 * 1024;
export const CONTINUE_LIMIT = 20;
export const CONTINUE_MIN_PROGRESS = 0.02;
export const COMPLETED_RATIO = 0.9;
export const IMPORT_LIMIT = 100;
const SLUG_MAX = 200;
const EPISODE_KEY_MAX = 200;
const MAX_DURATION_SEC = 48 * 60 * 60;

class ApiError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * The next episode's watch key after `episodeKey`, from the streams already
 * stored for the title. Servers can list different episode counts, so the first
 * server that knows a following episode wins. Null means the series is over
 * (or the key is not found anywhere), and the card is hidden.
 */
export function nextEpisodeKey(streams, episodeKey) {
  for (const server of Array.isArray(streams) ? streams : []) {
    const episodes = Array.isArray(server?.server_data) ? server.server_data : [];
    let index = episodes.findIndex((episode) => episode?.slug === episodeKey);
    if (index < 0 && /^\d+$/.test(episodeKey)) {
      const numeric = Number(episodeKey);
      if (numeric < episodes.length) index = numeric;
    }
    if (index < 0 || index + 1 >= episodes.length) continue;
    const next = episodes[index + 1];
    const slug = typeof next?.slug === 'string' ? next.slug.trim() : '';
    return slug || String(index + 1);
  }
  return null;
}

/**
 * Turn progress rows (newest first) into continue-watching items. Titles under
 * 2% are hidden; finished titles move to the next episode at progress 0, or
 * disappear when there is none.
 */
export function buildContinueItems(rows, streamsByMovie, toCard = card) {
  const items = [];
  for (const row of rows) {
    if (items.length >= CONTINUE_LIMIT) break;
    const positionSec = Number(row.p_position_sec);
    const durationSec = Number(row.p_duration_sec);
    const updatedAt = new Date(row.p_updated_at).toISOString();
    if (row.p_completed) {
      const next = nextEpisodeKey(streamsByMovie.get(row.id), row.p_episode_key);
      if (!next) continue;
      items.push({
        movie: toCard(row), episodeKey: next, positionSec: 0, durationSec: 0, progress: 0, updatedAt
      });
      continue;
    }
    const progress = durationSec > 0 ? Math.min(1, positionSec / durationSec) : 0;
    if (progress < CONTINUE_MIN_PROGRESS) continue;
    items.push({
      movie: toCard(row),
      episodeKey: row.p_episode_key,
      positionSec,
      durationSec,
      progress: Math.round(progress * 10000) / 10000,
      updatedAt
    });
  }
  return items;
}

function validSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= SLUG_MAX ? value : '';
}

function parseProgress(body, now) {
  const slug = validSlug(body.slug);
  const episodeKey = typeof body.episodeKey === 'string' ? body.episodeKey.trim() : '';
  const position = Number(body.positionSec);
  const duration = Number(body.durationSec);
  if (
    !slug || !episodeKey || episodeKey.length > EPISODE_KEY_MAX ||
    typeof body.positionSec !== 'number' || typeof body.durationSec !== 'number' ||
    !Number.isFinite(position) || !Number.isFinite(duration) ||
    position < 0 || duration < 1 || duration > MAX_DURATION_SEC ||
    position > duration + 5
  ) return null;
  const durationSec = Math.round(duration);
  const positionSec = Math.min(durationSec, Math.round(position));
  // Optional client clock in ms: lets a delayed beacon lose to a newer write.
  // Never trusted past "now" (a far-future stamp would freeze the row).
  let at = now;
  if (Number.isFinite(body.updatedAt)) at = Math.min(now + 60 * 1000, Math.max(0, body.updatedAt));
  return {
    slug,
    progress: {
      episodeKey,
      positionSec,
      durationSec,
      completed: positionSec / durationSec >= COMPLETED_RATIO,
      at: new Date(at)
    }
  };
}

function importList(value, now, limit) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Map();
  let skipped = 0;
  list.forEach((entry, index) => {
    const slug = validSlug(entry?.slug);
    if (index >= limit || !slug) { skipped += 1; return; }
    const parsed = typeof entry.savedAt === 'string' || typeof entry.savedAt === 'number'
      ? new Date(entry.savedAt).getTime() : NaN;
    const time = Number.isFinite(parsed) && parsed > Date.UTC(2000, 0, 1)
      ? Math.min(parsed, now) : now;
    const existing = seen.get(slug);
    if (existing === undefined) seen.set(slug, time);
    else { seen.set(slug, Math.min(existing, time)); skipped += 1; }
  });
  return {
    items: [...seen].map(([slug, time]) => ({ slug, at: new Date(time) })),
    skipped
  };
}

function clientIp(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || request.socket?.remoteAddress || 'unknown').slice(0, 64);
}

async function readJson(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    throw new ApiError(413, 'payload_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new ApiError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    return body;
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

function send(response, status, payload, headers = {}) {
  const base = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  };
  if (payload === undefined) {
    response.writeHead(status, base);
    response.end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...base,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

export function isAccountPath(pathname) {
  return pathname === '/api/me' || pathname.startsWith('/api/me/') ||
    pathname.startsWith('/api/auth/');
}

/**
 * Build the /api/auth/* and /api/me/* handler. Everything stateful is
 * injectable so tests run without PostgreSQL.
 */
export function createAccountHandler({
  repo = meRepository,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console
} = {}) {
  const loginLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, now });
  const registerLimiter = new RateLimiter({ limit: 5, windowMs: 60 * 60 * 1000, now });
  const failures = new FailureTracker({ now });

  function limited(result) {
    if (!result.allowed) {
      throw new ApiError(429, 'rate_limited', { 'retry-after': String(result.retryAfterSeconds) });
    }
  }

  async function authenticate(request) {
    const token = bearerToken(request);
    if (!token) throw new ApiError(401, 'unauthorized');
    const session = await repo.findSession(hashToken(token));
    const state = assessSession(session, now());
    if (!state.valid) throw new ApiError(401, 'unauthorized');
    if (state.renew) {
      await repo.renewSession(session.id, sessionExpiry(now())).catch((error) => {
        logger.warn?.('[api] session renew failed', error.message);
      });
    }
    return { userId: session.user_id, email: session.email, imported: Boolean(session.imported_at), token };
  }

  async function issueSession(user) {
    const token = newToken();
    const expiresAt = sessionExpiry(now());
    await repo.createSession(user.id, hashToken(token), expiresAt);
    return { token, expiresAt: expiresAt.toISOString(), user: { id: user.id, email: user.email } };
  }

  async function register(request, response) {
    limited(registerLimiter.take(clientIp(request)));
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) throw new ApiError(422, 'invalid_email');
    if (!validPassword(body.password)) throw new ApiError(422, 'weak_password');
    const user = await repo.createUser(email, await hashPassword(body.password));
    if (!user) throw new ApiError(409, 'email_taken');
    send(response, 201, await issueSession(user));
  }

  async function login(request, response) {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const key = clientIp(request) + '|' + email;
    limited(loginLimiter.take(key));
    const password = typeof body.password === 'string' ? body.password : '';
    let user = null;
    let ok = false;
    if (email && email.length <= 254 && password && password.length <= PASSWORD_MAX) {
      user = await repo.findUserByEmail(email);
      ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
    }
    if (!ok) {
      const delay = failureDelayMs(failures.fail(key));
      if (delay) await sleep(delay);
      throw new ApiError(401, 'invalid_credentials');
    }
    failures.reset(key);
    send(response, 200, await issueSession(user));
  }

  async function handle(request, response, url) {
    const { pathname } = url;
    const method = request.method;
    const allow = (methods) => {
      if (!methods.includes(method)) throw new ApiError(405, 'method_not_allowed', { allow: methods.join(', ') });
    };

    if (method === 'OPTIONS') {
      send(response, 204, undefined, { allow: 'GET, POST, PUT, DELETE, OPTIONS' });
      return;
    }

    if (pathname === '/api/auth/register') { allow(['POST']); return register(request, response); }
    if (pathname === '/api/auth/login') { allow(['POST']); return login(request, response); }
    if (pathname === '/api/auth/logout') {
      allow(['POST']);
      const session = await authenticate(request);
      await repo.deleteSession(hashToken(session.token));
      send(response, 204);
      return;
    }

    if (!isAccountPath(pathname) || pathname.startsWith('/api/auth/')) {
      throw new ApiError(404, 'not_found');
    }

    const segments = pathname.split('/').slice(3);
    const head = segments[0] || '';
    const rest = segments.slice(1);
    const known = ['', 'favorites', 'progress', 'continue-watching', 'history', 'import'];
    if (!known.includes(head) || rest.length > 1 || (rest.length && !['favorites', 'progress', 'history'].includes(head))) {
      throw new ApiError(404, 'not_found');
    }
    let slug = '';
    if (rest.length) {
      try { slug = validSlug(decodeURIComponent(rest[0])); } catch { slug = ''; }
    }

    // Method is checked before authentication only for shape; the session is
    // always verified before any body or data is touched.
    const routeMethods = {
      '': ['GET'],
      'continue-watching': ['GET'],
      import: ['POST'],
      progress: rest.length ? ['DELETE'] : ['PUT'],
      favorites: rest.length ? ['PUT', 'DELETE'] : ['GET'],
      history: rest.length ? ['PUT'] : ['GET']
    }[head];
    allow(routeMethods);
    const session = await authenticate(request);
    const userId = session.userId;

    if (head === '') {
      send(response, 200, { user: { id: userId, email: session.email }, imported: session.imported });
      return;
    }
    if (head === 'favorites' && !rest.length) {
      const rows = await repo.listFavorites(userId);
      send(response, 200, {
        items: rows.map((row) => ({ slug: row.slug, savedAt: new Date(row.at).toISOString() }))
      });
      return;
    }
    if (head === 'favorites') {
      if (method === 'DELETE') {
        if (slug) await repo.removeFavorite(userId, slug);
        send(response, 204);
        return;
      }
      if (!slug || !(await repo.addFavorite(userId, slug))) throw new ApiError(404, 'unknown_movie');
      send(response, 204);
      return;
    }
    if (head === 'progress' && !rest.length) {
      const parsed = parseProgress(await readJson(request), now());
      if (!parsed) throw new ApiError(422, 'invalid_progress');
      if (!(await repo.upsertProgress(userId, parsed.slug, parsed.progress))) {
        throw new ApiError(404, 'unknown_movie');
      }
      send(response, 204);
      return;
    }
    if (head === 'progress') {
      if (slug) await repo.deleteProgress(userId, slug);
      send(response, 204);
      return;
    }
    if (head === 'continue-watching') {
      const rows = await repo.listContinueRows(userId);
      const completedIds = rows.filter((row) => row.p_completed).map((row) => row.id);
      const streams = await repo.streamsForMovies(completedIds);
      send(response, 200, { items: buildContinueItems(rows, streams) });
      return;
    }
    if (head === 'history' && !rest.length) {
      const rows = await repo.listHistory(userId);
      send(response, 200, {
        items: rows.map((row) => ({ slug: row.slug, watchedAt: new Date(row.at).toISOString() }))
      });
      return;
    }
    if (head === 'history') {
      if (!slug || !(await repo.touchHistory(userId, slug))) throw new ApiError(404, 'unknown_movie');
      send(response, 204);
      return;
    }
    // import
    const body = await readJson(request);
    const at = now();
    const favorites = importList(body.favorites, at, IMPORT_LIMIT);
    const history = importList(body.history, at, IMPORT_LIMIT);
    const counts = await repo.importUserData(userId, favorites.items, history.items);
    const accepted = favorites.items.length + history.items.length;
    const known2 = counts.favorites + counts.history;
    send(response, 200, {
      favorites: counts.favorites,
      history: counts.history,
      skipped: favorites.skipped + history.skipped + (accepted - known2)
    });
  }

  return async function handleAccountRoute(request, response, url) {
    try {
      await handle(request, response, url);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      send(response, error.status, { error: error.code }, error.headers);
    }
  };
}
