import {
  AuthOverloadedError,
  FailureTracker,
  assessSession,
  bearerToken,
  dummyVerify,
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
import { createHash } from 'node:crypto';
import { redis } from './cache.js';
import { createAuthLimits } from './authLimits.js';
import { createTurnstileVerifier } from './turnstile.js';
import * as meRepository from './meRepository.js';

export const BODY_LIMIT_BYTES = 32 * 1024;
export const IMPORT_LIMIT = 100;
const SLUG_MAX = 200;

class ApiError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function validSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= SLUG_MAX ? value : '';
}

const EP_FIELD_MAX = 100;

function cleanField(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > EP_FIELD_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return null;
  return text;
}

/**
 * Validate { serverName, episodeKey, episodeName }. Returns { ep } (ep null when
 * nothing was given) or { invalid: true }. episodeKey and episodeName go
 * together; serverName is optional but meaningless without an episode.
 */
function parseEpisode(value) {
  if (value === undefined || value === null) return { ep: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { invalid: true };
  const given = (v) => v !== undefined && v !== null;
  if (!given(value.serverName) && !given(value.episodeKey) && !given(value.episodeName)) return { ep: null };
  if (!given(value.episodeKey) || !given(value.episodeName)) return { invalid: true };
  const episodeKey = cleanField(value.episodeKey);
  const episodeName = cleanField(value.episodeName);
  const serverName = given(value.serverName) ? cleanField(value.serverName) : null;
  if (!episodeKey || !episodeName || (given(value.serverName) && !serverName)) return { invalid: true };
  return { ep: { serverName, episodeKey, episodeName } };
}

function importList(value, now, limit, withEpisode = false) {
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
    const ep = withEpisode ? parseEpisode(entry.ep).ep || null : null;
    const existing = seen.get(slug);
    if (existing === undefined) seen.set(slug, { time, ep });
    else {
      // Duplicate slug: the earliest time wins, as before; keep the episode of the latest entry.
      seen.set(slug, { time: Math.min(existing.time, time), ep: time >= existing.time && ep ? ep : existing.ep });
      skipped += 1;
    }
  });
  return {
    items: [...seen].map(([slug, { time, ep }]) => (
      withEpisode ? { slug, at: new Date(time), ep } : { slug, at: new Date(time) }
    )),
    skipped
  };
}

function registerGlobalLimit() {
  const value = Number.parseInt(process.env.AUTH_REGISTER_GLOBAL_PER_HOUR ?? '', 10);
  return Number.isFinite(value) && value >= 1 ? value : 300;
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

function adminEmails() {
  return new Set(String(process.env.ADMIN_EMAILS || '').split(',').map((e) => normalizeEmail(e)).filter(Boolean));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  logger = console,
  limits = createAuthLimits({ getClient: redis, now, logger }),
  registerGlobalPerHour = registerGlobalLimit(),
  turnstile = createTurnstileVerifier({ logger }),
  admins = adminEmails()
} = {}) {
  const failures = new FailureTracker({ now });

  const MIN = 60;
  const HOUR = 60 * MIN;
  const sha = (value) => createHash('sha256').update(value).digest('hex');

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
    limited(await limits.take('register-ip', clientIp(request), 5, HOUR));
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) throw new ApiError(422, 'invalid_email');
    if (!validPassword(body.password)) throw new ApiError(422, 'weak_password');
    // Checked before hashing, spent only by an account actually created, so
    // email_taken and malformed requests cannot burn the shared signup budget.
    limited(await limits.peek('register-global', 'all', registerGlobalPerHour, HOUR));
    if (turnstile.enabled) {
      const check = await turnstile.verify(body.turnstileToken, clientIp(request));
      if (check.unavailable) throw new ApiError(503, 'busy', { 'retry-after': '2' });
      if (!check.ok) throw new ApiError(400, 'captcha_failed');
    }
    const user = await repo.createUser(email, await hashPassword(body.password));
    if (!user) throw new ApiError(409, 'email_taken');
    await limits.take('register-global', 'all', registerGlobalPerHour, HOUR);
    send(response, 201, await issueSession(user));
  }

  async function login(request, response) {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const ip = clientIp(request);
    const key = ip + '|' + email;
    limited(await limits.take('login-ip', ip, 30, 15 * MIN));
    limited(await limits.take('login-ip-email', key, 10, 15 * MIN));
    // Only failed attempts count towards the per-email bucket, so a stranger's
    // correct login cannot be what locks the owner out.
    const emailKey = email ? sha(email) : '';
    if (emailKey) limited(await limits.peek('login-email', emailKey, 20, HOUR));
    // Consecutive failures lock this IP|email out for the backoff period. The
    // request is refused at once instead of being held open.
    const lockedMs = failures.lockedForMs(key);
    if (lockedMs > 0) {
      throw new ApiError(429, 'rate_limited', { 'retry-after': String(Math.max(1, Math.ceil(lockedMs / 1000))) });
    }
    const password = typeof body.password === 'string' ? body.password : '';
    let user = null;
    let ok = false;
    if (email && email.length <= 254 && password && password.length <= PASSWORD_MAX) {
      user = await repo.findUserByEmail(email);
      ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
    }
    if (!ok) {
      failures.fail(key);
      if (emailKey) await limits.take('login-email', emailKey, 20, HOUR);
      throw new ApiError(401, 'invalid_credentials');
    }
    failures.reset(key);
    send(response, 200, await issueSession(user));
  }

  // Admin = session email in ADMIN_EMAILS. Registration is unverified, so the
  // admin account must exist (unique email) and must never be deletable here.
  async function admin(request, response, rest) {
    const session = await authenticate(request);
    if (!admins.has(session.email)) throw new ApiError(404, 'not_found');
    const method = request.method;
    const url = new URL(request.url, 'http://x');
    const [section, id, action, ...extra] = rest;
    if (extra.length || section !== 'users') throw new ApiError(404, 'not_found');
    if (!id) {
      if (method !== 'GET') throw new ApiError(405, 'method_not_allowed', { allow: 'GET' });
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const page = Math.min(Math.max(Number.parseInt(url.searchParams.get('page') || '1', 10) || 1, 1), 10000);
      const limit = 25;
      const [overview, list] = await Promise.all([
        repo.adminOverview(),
        repo.adminListUsers({ q, limit, offset: (page - 1) * limit })
      ]);
      send(response, 200, {
        overview: { users: overview.users, new7d: overview.new_7d, activeSessions: overview.active_sessions },
        total: list.total,
        page,
        pageSize: limit,
        items: list.rows.map((row) => ({
          id: row.id,
          email: row.email,
          createdAt: new Date(row.created_at).toISOString(),
          lastActive: row.last_active ? new Date(row.last_active).toISOString() : null,
          sessions: row.sessions,
          favorites: row.favorites,
          history: row.history,
          isAdmin: admins.has(row.email)
        }))
      });
      return;
    }
    if (!UUID_RE.test(id)) throw new ApiError(404, 'not_found');
    const target = await repo.adminFindUser(id);
    if (!target) throw new ApiError(404, 'not_found');
    if (action === 'sessions') {
      if (method !== 'DELETE') throw new ApiError(405, 'method_not_allowed', { allow: 'DELETE' });
      send(response, 200, { revoked: await repo.adminRevokeSessions(id) });
      return;
    }
    if (action) throw new ApiError(404, 'not_found');
    if (method !== 'DELETE') throw new ApiError(405, 'method_not_allowed', { allow: 'DELETE' });
    if (admins.has(target.email)) throw new ApiError(403, 'cannot_delete_admin');
    await repo.adminDeleteUser(id);
    logger.warn?.('[api] admin deleted user', id);
    send(response, 204);
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
    if (head === 'admin') return admin(request, response, rest);
    const known = ['', 'favorites', 'history', 'import'];
    if (!known.includes(head) || rest.length > 1 || (rest.length && !['favorites', 'history'].includes(head))) {
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
      import: ['POST'],
      favorites: rest.length ? ['PUT', 'DELETE'] : ['GET'],
      history: rest.length ? ['PUT'] : ['GET']
    }[head];
    allow(routeMethods);
    const session = await authenticate(request);
    const userId = session.userId;

    if (head === '') {
      send(response, 200, { user: { id: userId, email: session.email }, imported: session.imported, admin: admins.has(session.email) });
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
    if (head === 'history' && !rest.length) {
      const rows = await repo.listHistory(userId);
      send(response, 200, {
        items: rows.map((row) => ({
          slug: row.slug,
          watchedAt: new Date(row.at).toISOString(),
          serverName: row.serverName ?? null,
          episodeKey: row.episodeKey ?? null,
          episodeName: row.episodeName ?? null
        }))
      });
      return;
    }
    if (head === 'history') {
      const parsed = parseEpisode(await readJson(request));
      if (parsed.invalid) throw new ApiError(400, 'invalid_episode');
      if (!slug || !(await repo.touchHistory(userId, slug, parsed.ep))) throw new ApiError(404, 'unknown_movie');
      send(response, 204);
      return;
    }
    // import
    const body = await readJson(request);
    const at = now();
    const favorites = importList(body.favorites, at, IMPORT_LIMIT);
    const history = importList(body.history, at, IMPORT_LIMIT, true);
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
      if (error instanceof AuthOverloadedError) {
        send(response, 503, { error: 'busy' }, { 'retry-after': '2' });
        return;
      }
      if (!(error instanceof ApiError)) throw error;
      send(response, error.status, { error: error.code }, error.headers);
    }
  };
}
