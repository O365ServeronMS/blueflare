import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  AuthOverloadedError,
  FailureTracker,
  HashGate,
  RateLimiter,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
  assessSession,
  failureDelayMs,
  hashPassword,
  hashToken,
  newToken,
  hashGate,
  verifyPassword
} from '../src/auth.js';
import { createAuthLimits } from '../src/authLimits.js';
import { createAccountHandler } from '../src/meApi.js';
import { pool } from '../src/db.js';
import * as meRepository from '../src/meRepository.js';

// ---- in-memory repository with the same contract as meRepository ----------

function fakeRepo({ movies = ['a', 'b', 'c'] } = {}) {
  const state = {
    users: new Map(), sessions: new Map(), favorites: new Map(),
    history: new Map(), imported: new Set(), renewed: 0,
    clock: () => new Date()
  };
  const bySlug = new Set(movies);
  return {
    state,
    async createUser(email, hash) {
      if ([...state.users.values()].some((u) => u.email === email)) return null;
      const user = { id: 'u' + (state.users.size + 1), email, password_hash: hash };
      state.users.set(user.id, user);
      return { id: user.id, email };
    },
    async findUserByEmail(email) {
      return [...state.users.values()].find((u) => u.email === email) || null;
    },
    async createSession(userId, tokenHash, expiresAt) {
      state.sessions.set(tokenHash, {
        id: tokenHash.slice(0, 8), user_id: userId, expires_at: expiresAt, renewed_at: state.clock()
      });
    },
    async findSession(tokenHash) {
      const s = state.sessions.get(tokenHash);
      if (!s) return null;
      const user = state.users.get(s.user_id);
      return { ...s, email: user.email, imported_at: state.imported.has(s.user_id) ? new Date() : null };
    },
    async renewSession(id, expiresAt) {
      state.renewed += 1;
      for (const s of state.sessions.values()) if (s.id === id) { s.expires_at = expiresAt; s.renewed_at = state.clock(); }
    },
    async deleteSession(tokenHash) { state.sessions.delete(tokenHash); },
    async listFavorites(userId) {
      return [...(state.favorites.get(userId) || new Map())].map(([slug, at]) => ({ slug, at }));
    },
    async addFavorite(userId, slug) {
      if (!bySlug.has(slug)) return false;
      const map = state.favorites.get(userId) || new Map();
      if (!map.has(slug)) map.set(slug, new Date());
      state.favorites.set(userId, map);
      return true;
    },
    async removeFavorite(userId, slug) { state.favorites.get(userId)?.delete(slug); },
    async listHistory(userId) {
      return [...(state.history.get(userId) || new Map())].map(([slug, h]) => ({
        slug, at: h.at, serverName: h.serverName ?? null, episodeKey: h.episodeKey ?? null, episodeName: h.episodeName ?? null
      }));
    },
    async touchHistory(userId, slug, ep = null) {
      if (!bySlug.has(slug)) return false;
      const map = state.history.get(userId) || new Map();
      const old = map.get(slug) || {};
      map.set(slug, { ...(ep ? { serverName: ep.serverName, episodeKey: ep.episodeKey, episodeName: ep.episodeName } : old), at: new Date() });
      state.history.set(userId, map);
      return true;
    },
    async importUserData(userId, favorites, history) {
      const fav = state.favorites.get(userId) || new Map();
      const his = state.history.get(userId) || new Map();
      let f = 0; let h = 0;
      for (const item of favorites) if (bySlug.has(item.slug)) { f += 1; if (!fav.has(item.slug)) fav.set(item.slug, item.at); }
      for (const item of history) {
        if (!bySlug.has(item.slug)) continue;
        h += 1;
        const old = his.get(item.slug);
        if (!old || (item.at > old.at && item.ep)) his.set(item.slug, { ...(item.ep || {}), at: item.at });
        else if (item.at > old.at) his.set(item.slug, { ...old, at: item.at });
      }
      state.favorites.set(userId, fav);
      state.history.set(userId, his);
      state.imported.add(userId);
      return { favorites: f, history: h };
    }
  };
}

async function withApi(options, run) {
  const repo = options.repo || fakeRepo();
  let time = options.start || Date.UTC(2026, 8, 30);
  const clock = { now: () => time, advance: (ms) => { time += ms; } };
  repo.state.clock = () => new Date(time);
  const handler = createAccountHandler({
    repo,
    now: clock.now,
    logger: { warn() {} },
    // No Valkey in tests: memory counters, driven by the fake clock.
    limits: options.limits || createAuthLimits({ now: clock.now, logger: { warn() {} } }),
    ...(options.handler || {})
  });
  const server = http.createServer((request, response) => {
    handler(request, response, new URL(request.url, 'http://x')).catch((error) => {
      response.writeHead(503); response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(method, path, { token, body, headers = {}, raw } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  }
  try {
    await run({ call, repo, clock });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function signup(call, email = 'a@example.com') {
  const result = await call('POST', '/api/auth/register', { body: { email, password: 'correct horse' } });
  assert.equal(result.status, 201);
  return result.json;
}

// ---- hashing and sessions --------------------------------------------------

test('scrypt hashing verifies, salts, and rejects wrong or malformed hashes', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong horse', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'scrypt$1$1$1$AA==$'), false);
});

test('tokens are 32 random bytes and only their sha256 is stored', () => {
  const token = newToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(token, newToken());
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(token), token);
});

test('session expiry is 30 days and renewal is throttled to once an hour', () => {
  const now = Date.UTC(2026, 8, 30);
  const fresh = { expires_at: new Date(now + SESSION_TTL_MS), renewed_at: new Date(now - 60000) };
  assert.deepEqual(assessSession(fresh, now), { valid: true, renew: false });
  const stale = { ...fresh, renewed_at: new Date(now - SESSION_RENEW_AFTER_MS) };
  assert.deepEqual(assessSession(stale, now), { valid: true, renew: true });
  const expired = { expires_at: new Date(now - 1), renewed_at: new Date(now - 1000) };
  assert.deepEqual(assessSession(expired, now), { valid: false, renew: false });
  assert.deepEqual(assessSession(null, now), { valid: false, renew: false });
});

test('an expired session is rejected and a live one slides forward', async () => {
  await withApi({}, async ({ call, clock, repo }) => {
    const { token } = await signup(call);
    assert.equal((await call('GET', '/api/me', { token })).status, 200);
    assert.equal(repo.state.renewed, 0);
    clock.advance(SESSION_RENEW_AFTER_MS + 1000);
    assert.equal((await call('GET', '/api/me', { token })).status, 200);
    assert.equal(repo.state.renewed, 1);
    clock.advance(SESSION_TTL_MS - SESSION_RENEW_AFTER_MS);
    assert.equal((await call('GET', '/api/me', { token })).status, 200);
    clock.advance(SESSION_TTL_MS + 1000);
    const expired = await call('GET', '/api/me', { token });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error, 'unauthorized');
  });
});

// ---- rate limiting ---------------------------------------------------------

test('RateLimiter blocks over the limit, reports Retry-After, and recovers', () => {
  let time = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => time });
  assert.equal(limiter.take('k').allowed, true);
  assert.equal(limiter.take('k').allowed, true);
  const blocked = limiter.take('k');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.take('other').allowed, true);
  time = 1001;
  assert.equal(limiter.take('k').allowed, true);
});

test('RateLimiter stays bounded under many distinct keys', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 60000, maxKeys: 5 });
  for (let i = 0; i < 50; i += 1) limiter.take('k' + i);
  assert.ok(limiter.hits.size <= 5);
});

test('failure delay is zero for 4 failures then monotonic and capped', () => {
  assert.equal(failureDelayMs(4), 0);
  const delays = [5, 6, 7, 8, 9, 20].map(failureDelayMs);
  assert.deepEqual(delays.slice(0, 3), [250, 500, 1000]);
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] >= delays[i - 1]);
  assert.equal(delays.at(-1), 5000);
  const tracker = new FailureTracker();
  tracker.fail('k'); tracker.fail('k');
  assert.equal(tracker.count('k'), 2);
  tracker.reset('k');
  assert.equal(tracker.count('k'), 0);
});

test('login: 10 attempts per (ip,email) then 429 with Retry-After; register 5 per IP', async () => {
  await withApi({}, async ({ call, clock }) => {
    await signup(call);
    let last;
    for (let i = 0; i < 10; i += 1) {
      last = await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'nope nope' } });
      assert.equal(last.status, 401);
      clock.advance(6000); // step past the consecutive-failure lock
    }
    last = await call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'correct horse' } });
    assert.equal(last.status, 429);
    assert.equal(last.json.error, 'rate_limited');
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.equal(last.headers.get('cache-control'), 'no-store');
    // A different email from the same IP has its own bucket.
    const other = await call('POST', '/api/auth/login', { body: { email: 'b@example.com', password: 'x' } });
    assert.equal(other.status, 401);
  });
  await withApi({}, async ({ call }) => {
    for (let i = 0; i < 5; i += 1) await signup(call, 'u' + i + '@example.com');
    const sixth = await call('POST', '/api/auth/register', { body: { email: 'u9@example.com', password: 'correct horse' } });
    assert.equal(sixth.status, 429);
    assert.ok(Number(sixth.headers.get('retry-after')) > 0);
  });
});

const badLogin = (call, email = 'x@example.com', headers = {}) => call('POST', '/api/auth/login', {
  body: { email, password: 'bad password' }, headers
});

test('login after 5 consecutive failures is refused at once with Retry-After and holds no connection', async () => {
  await withApi({}, async ({ call, clock }) => {
    for (let i = 0; i < 5; i += 1) assert.equal((await badLogin(call)).status, 401);
    const started = Date.now();
    const locked = await badLogin(call);
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error, 'rate_limited');
    assert.equal(locked.headers.get('retry-after'), '1');
    assert.equal(locked.headers.get('cache-control'), 'no-store');
    // The old behaviour slept failureDelayMs (250 ms at this step) before answering.
    assert.ok(Date.now() - started < 200, 'must not sleep');
    // Lock expires with time, and the delay grows.
    clock.advance(1100);
    assert.equal((await badLogin(call)).status, 401);
    assert.equal((await badLogin(call)).status, 429);
    clock.advance(1100);
    assert.equal((await badLogin(call)).status, 401);
    const longer = await badLogin(call);
    assert.equal(longer.status, 429);
    assert.equal(longer.headers.get('retry-after'), '1');
  });
});

test('login-ip: one IP rotating emails is capped at 30 per 15 minutes', async () => {
  await withApi({}, async ({ call, clock }) => {
    for (let i = 0; i < 30; i += 1) assert.equal((await badLogin(call, 'e' + i + '@example.com')).status, 401);
    const blocked = await badLogin(call, 'fresh@example.com');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // Another IP is unaffected.
    assert.equal((await badLogin(call, 'fresh@example.com', { 'x-forwarded-for': '9.9.9.9' })).status, 401);
    clock.advance(15 * 60 * 1000 + 1000);
    assert.equal((await badLogin(call, 'fresh@example.com')).status, 401);
  });
});

test('login-email: 20 failures per hour across IPs, successes do not count', async () => {
  await withApi({}, async ({ call, clock }) => {
    await signup(call, 'victim@example.com');
    // Correct logins never count against the email bucket.
    for (let i = 0; i < 25; i += 1) {
      const ok = await call('POST', '/api/auth/login', {
        body: { email: 'victim@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '10.0.0.' + i }
      });
      assert.equal(ok.status, 200);
    }
    for (let i = 0; i < 20; i += 1) {
      const r = await badLogin(call, 'victim@example.com', { 'x-forwarded-for': '10.1.0.' + i });
      assert.equal(r.status, 401);
    }
    const blocked = await badLogin(call, 'victim@example.com', { 'x-forwarded-for': '10.2.0.1' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // The known-limitation: even the right password is refused until the window ends.
    const owner = await call('POST', '/api/auth/login', {
      body: { email: 'victim@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '10.3.0.1' }
    });
    assert.equal(owner.status, 429);
    clock.advance(60 * 60 * 1000 + 1000);
    const later = await call('POST', '/api/auth/login', {
      body: { email: 'victim@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '10.3.0.1' }
    });
    assert.equal(later.status, 200);
  });
});

test('register-global caps signups per hour across IPs and is env-configurable', async () => {
  await withApi({ handler: { registerGlobalPerHour: 3 } }, async ({ call, clock }) => {
    for (let i = 0; i < 3; i += 1) {
      const r = await call('POST', '/api/auth/register', {
        body: { email: 'g' + i + '@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '7.7.7.' + i }
      });
      assert.equal(r.status, 201);
    }
    const capped = await call('POST', '/api/auth/register', {
      body: { email: 'g9@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '7.7.7.99' }
    });
    assert.equal(capped.status, 429);
    assert.equal(capped.json.error, 'rate_limited');
    assert.ok(Number(capped.headers.get('retry-after')) > 0);
    // Invalid requests do not burn the shared budget.
    clock.advance(60 * 60 * 1000 + 1000);
    const bad = await call('POST', '/api/auth/register', { body: { email: 'nope', password: 'correct horse' } });
    assert.equal(bad.status, 422);
  });
});

test('register-global is not spent by email_taken responses', async () => {
  await withApi({ handler: { registerGlobalPerHour: 2 } }, async ({ call }) => {
    const first = await call('POST', '/api/auth/register', { body: { email: 'dup@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '8.8.8.1' } });
    assert.equal(first.status, 201);
    for (let i = 0; i < 4; i += 1) {
      const dup = await call('POST', '/api/auth/register', { body: { email: 'dup@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '8.8.8.' + (10 + i) } });
      assert.equal(dup.status, 409);
    }
    const second = await call('POST', '/api/auth/register', { body: { email: 'other@example.com', password: 'correct horse' }, headers: { 'x-forwarded-for': '8.8.8.99' } });
    assert.equal(second.status, 201);
  });
});

test('hash overload maps to 503 busy with Retry-After and no-store, on login and register', async () => {
  const original = { c: hashGate.concurrency, q: hashGate.maxQueue };
  await withApi({}, async ({ call }) => {
    await signup(call, 'busy@example.com');
    hashGate.concurrency = 1; hashGate.maxQueue = 0;
    let release;
    const hold = hashGate.run(() => new Promise((resolve) => { release = resolve; })); // occupies the only slot
    try {
      const login = await call('POST', '/api/auth/login', { body: { email: 'busy@example.com', password: 'correct horse' } });
      assert.equal(login.status, 503);
      assert.deepEqual(login.json, { error: 'busy' });
      assert.equal(login.headers.get('retry-after'), '2');
      assert.equal(login.headers.get('cache-control'), 'no-store');
      const ghost = await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'correct horse' } });
      assert.equal(ghost.status, 503);
      const reg = await call('POST', '/api/auth/register', { body: { email: 'new@example.com', password: 'correct horse' } });
      assert.equal(reg.status, 503);
      assert.equal(reg.headers.get('retry-after'), '2');
    } finally {
      release();
      await hold;
      hashGate.concurrency = original.c; hashGate.maxQueue = original.q;
    }
    // A refused attempt is not a failed credential: it did not count towards the lock.
    const ok = await call('POST', '/api/auth/login', { body: { email: 'busy@example.com', password: 'correct horse' } });
    assert.equal(ok.status, 200);
  });
});

// ---- HashGate --------------------------------------------------------------

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('HashGate limits concurrency, queues in order, and refuses when the queue is full', async () => {
  const gate = new HashGate({ concurrency: 2, maxQueue: 2, waitMs: 1000 });
  let running = 0; let peak = 0; const order = [];
  const releases = [];
  const job = (id) => gate.run(async () => {
    running += 1; peak = Math.max(peak, running); order.push(id);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return id;
  });
  const results = [job(1), job(2), job(3), job(4)];
  await tick(5);
  assert.deepEqual(order, [1, 2]);
  await assert.rejects(job(5), (error) => error instanceof AuthOverloadedError && error.code === 'overloaded');
  releases.shift()(); await tick(5);
  assert.deepEqual(order, [1, 2, 3]);
  while (releases.length || gate.active) { releases.shift()?.(); await tick(2); }
  assert.deepEqual(await Promise.all(results), [1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(gate.active, 0);
  assert.equal(gate.queue.length, 0);
});

test('HashGate refuses a waiter after the wait timeout and keeps serving afterwards', async () => {
  const gate = new HashGate({ concurrency: 1, maxQueue: 4, waitMs: 30 });
  let release;
  const first = gate.run(() => new Promise((resolve) => { release = resolve; }));
  const started = Date.now();
  await assert.rejects(gate.run(async () => 'late'), AuthOverloadedError);
  assert.ok(Date.now() - started >= 25);
  assert.equal(gate.queue.length, 0);
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await gate.run(async () => 'again'), 'again');
});

test('HashGate slot is released when the task throws', async () => {
  const gate = new HashGate({ concurrency: 1, maxQueue: 0 });
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

// ---- authLimits ------------------------------------------------------------

function fakeValkey() {
  const store = new Map(); const ttls = new Map(); const calls = [];
  return {
    store, ttls, calls,
    async incr(key) { calls.push(['incr', key]); const n = (store.get(key) || 0) + 1; store.set(key, n); return n; },
    async expire(key, sec) { calls.push(['expire', key, sec]); ttls.set(key, sec); return 1; },
    async ttl(key) { return ttls.get(key) ?? -1; },
    async get(key) { const v = store.get(key); return v === undefined ? null : String(v); }
  };
}

test('authLimits uses Valkey INCR+EXPIRE with sha256 keys and no raw identifiers', async () => {
  const client = fakeValkey();
  const limits = createAuthLimits({ getClient: async () => client, logger: { warn() {} } });
  const email = 'someone@example.com';
  assert.deepEqual(await limits.take('login-email', email, 2, 3600), { allowed: true, retryAfterSeconds: 0 });
  assert.equal((await limits.take('login-email', email, 2, 3600)).allowed, true);
  const third = await limits.take('login-email', email, 2, 3600);
  assert.deepEqual(third, { allowed: false, retryAfterSeconds: 3600 });
  assert.equal(client.calls.filter(([op]) => op === 'expire').length, 1, 'EXPIRE only on the first hit');
  for (const key of client.store.keys()) {
    assert.match(key, /^auth:rl:login-email:[0-9a-f]{64}$/);
    assert.ok(!key.includes('someone') && !key.includes('example'));
  }
  // peek reads without recording.
  const before = client.store.size && [...client.store.values()][0];
  assert.equal((await limits.peek('login-email', email, 2, 3600)).allowed, false);
  assert.equal((await limits.peek('login-email', 'other@example.com', 2, 3600)).allowed, true);
  assert.equal([...client.store.values()][0], before);
});

test('authLimits falls back to memory on Valkey errors and timeouts, and logs', async () => {
  const warnings = [];
  const logger = { warn: (...a) => warnings.push(a.join(' ')) };
  const failing = createAuthLimits({ getClient: async () => { throw new Error('ECONNREFUSED'); }, logger });
  assert.equal((await failing.take('b', 'k', 1, 60)).allowed, true);
  const blocked = await failing.take('b', 'k', 1, 60);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ECONNREFUSED/);
  assert.ok(!warnings[0].includes('"k"'));

  const slowClient = { async incr() { await tick(300); return 1; } };
  const slow = createAuthLimits({ getClient: async () => slowClient, logger });
  const started = Date.now();
  assert.equal((await slow.take('b', 'k', 1, 60)).allowed, true);
  assert.ok(Date.now() - started < 250, 'gave up at ~100 ms');
  assert.equal((await slow.take('b', 'k', 1, 60)).allowed, false, 'memory counters took over');

  // A client error mid-operation also falls back.
  const broken = createAuthLimits({ getClient: async () => ({ incr: async () => { throw new Error('LOADING'); } }), logger });
  assert.equal((await broken.take('b', 'k', 5, 60)).allowed, true);
});

test('authLimits skips Valkey during backoff and repairs a key without TTL', async () => {
  let attempts = 0; let time = 0;
  const limits = createAuthLimits({
    getClient: async () => { attempts += 1; throw new Error('down'); },
    logger: { warn() {} }, clock: () => time, backoffMs: 1000
  });
  await limits.take('b', 'k', 5, 60); await limits.take('b', 'k', 5, 60);
  assert.equal(attempts, 1);
  time = 1001;
  await limits.take('b', 'k', 5, 60);
  assert.equal(attempts, 2);

  const client = fakeValkey();
  const repair = createAuthLimits({ getClient: async () => client });
  client.store.set(`auth:rl:b:${(await import('node:crypto')).createHash('sha256').update('k').digest('hex')}`, 5);
  const result = await repair.take('b', 'k', 1, 60);
  assert.deepEqual(result, { allowed: false, retryAfterSeconds: 60 });
  assert.equal([...client.ttls.values()][0], 60);
});

// ---- register / login / logout --------------------------------------------

test('register, login, me, logout flow with uniform 401s', async () => {
  await withApi({}, async ({ call, repo }) => {
    const registered = await call('POST', '/api/auth/register', {
      body: { email: '  Steve@Example.COM ', password: 'correct horse' }
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.json.user.email, 'steve@example.com');
    assert.equal(registered.headers.get('cache-control'), 'no-store');
    assert.ok(Date.parse(registered.json.expiresAt) > Date.now() - 1e12);
    // Only the hash of the token is stored.
    assert.ok(!repo.state.sessions.has(registered.json.token));
    assert.ok(repo.state.sessions.has(hashToken(registered.json.token)));

    const dup = await call('POST', '/api/auth/register', { body: { email: 'steve@example.com', password: 'correct horse' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'email_taken');
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'nope', password: 'correct horse' } })).json.error, 'invalid_email');
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'b@example.com', password: 'short' } })).json.error, 'weak_password');
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'b@example.com', password: 'x'.repeat(129) } })).json.error, 'weak_password');

    const wrongPassword = await call('POST', '/api/auth/login', { body: { email: 'steve@example.com', password: 'wrong horse' } });
    const unknownEmail = await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'wrong horse' } });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.json, unknownEmail.json);
    assert.equal(wrongPassword.json.error, 'invalid_credentials');

    const login = await call('POST', '/api/auth/login', { body: { email: 'STEVE@example.com', password: 'correct horse' } });
    assert.equal(login.status, 200);
    const me = await call('GET', '/api/me', { token: login.json.token });
    assert.deepEqual(me.json, { user: registered.json.user, imported: false });

    const out = await call('POST', '/api/auth/logout', { token: login.json.token });
    assert.equal(out.status, 204);
    assert.equal(out.headers.get('cache-control'), 'no-store');
    assert.equal((await call('GET', '/api/me', { token: login.json.token })).status, 401);
    // The other session is untouched.
    assert.equal((await call('GET', '/api/me', { token: registered.json.token })).status, 200);
  });
});

test('me routes require a Bearer token and account paths refuse caching or odd input', async () => {
  await withApi({}, async ({ call }) => {
    assert.equal((await call('GET', '/api/me')).status, 401);
    assert.equal((await call('GET', '/api/me', { token: 'x'.repeat(43) })).status, 401);
    assert.equal((await call('GET', '/api/me/unknown')).status, 404);
    assert.equal((await call('GET', '/api/auth/login')).status, 405);
    const options = await call('OPTIONS', '/api/me/history/a');
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('cache-control'), 'no-store');
    const bad = await call('POST', '/api/auth/login', { raw: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    const big = await call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'x'.repeat(40000) } });
    assert.equal(big.status, 413);
  });
});

// ---- favorites / history idempotency --------------------------------------

test('favorites and history writes are idempotent; unknown movies are 404', async () => {
  await withApi({}, async ({ call }) => {
    const { token } = await signup(call);
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await call('PUT', '/api/me/favorites/a', { token })).status, 204);
      assert.equal((await call('PUT', '/api/me/history/a', { token })).status, 204);
    }
    assert.equal((await call('GET', '/api/me/favorites', { token })).json.items.length, 1);
    assert.equal((await call('GET', '/api/me/history', { token })).json.items.length, 1);
    assert.equal((await call('PUT', '/api/me/favorites/zzz', { token })).json.error, 'unknown_movie');
    assert.equal((await call('PUT', '/api/me/history/zzz', { token })).status, 404);
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await call('DELETE', '/api/me/favorites/a', { token })).status, 204);
      assert.equal((await call('DELETE', '/api/me/favorites/never', { token })).status, 204);
    }
    assert.deepEqual((await call('GET', '/api/me/favorites', { token })).json.items, []);
  });
});

// ---- episode history -------------------------------------------------------

test('history stores and returns the last episode; a plain touch keeps it', async () => {
  await withApi({}, async ({ call }) => {
    const { token } = await signup(call);
    const ep = { serverName: ' Vietsub #1 ', episodeKey: 'tap-5', episodeName: 'Tập 5' };
    assert.equal((await call('PUT', '/api/me/history/a', { token, body: ep })).status, 204);
    let item = (await call('GET', '/api/me/history', { token })).json.items[0];
    assert.deepEqual(
      { s: item.serverName, k: item.episodeKey, n: item.episodeName },
      { s: 'Vietsub #1', k: 'tap-5', n: 'Tập 5' }
    );
    assert.ok(!Number.isNaN(Date.parse(item.watchedAt)));
    assert.equal((await call('PUT', '/api/me/history/a', { token })).status, 204);
    item = (await call('GET', '/api/me/history', { token })).json.items[0];
    assert.equal(item.episodeKey, 'tap-5');
    // serverName is optional.
    assert.equal((await call('PUT', '/api/me/history/a', { token, body: { episodeKey: 'tap-6', episodeName: 'Tập 6' } })).status, 204);
    item = (await call('GET', '/api/me/history', { token })).json.items[0];
    assert.deepEqual([item.serverName, item.episodeKey], [null, 'tap-6']);
    // A movie with no episode reads back nulls.
    await call('PUT', '/api/me/history/b', { token });
    const b = (await call('GET', '/api/me/history', { token })).json.items.find((x) => x.slug === 'b');
    assert.deepEqual([b.serverName, b.episodeKey, b.episodeName], [null, null, null]);
  });
});

test('history episode validation returns 400 and stores nothing', async () => {
  await withApi({}, async ({ call, repo }) => {
    const { token } = await signup(call);
    const ok = { serverName: 'S', episodeKey: 'k', episodeName: 'N' };
    for (const bad of [
      { ...ok, episodeName: undefined },
      { ...ok, episodeKey: undefined },
      { serverName: 'S' },
      { ...ok, serverName: 5 },
      { ...ok, serverName: '   ' },
      { ...ok, episodeKey: 'x'.repeat(101) },
      { ...ok, episodeName: 'x'.repeat(101) },
      { ...ok, serverName: 'x'.repeat(101) },
      { ...ok, episodeKey: 'a\u0000b' },
      { ...ok, episodeName: 'line\nbreak' },
      { ...ok, episodeKey: ['k'] }
    ]) {
      const res = await call('PUT', '/api/me/history/a', { token, body: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.json.error, 'invalid_episode');
    }
    assert.equal(repo.state.history.get('u1'), undefined);
    const edge = { ...ok, episodeKey: 'x'.repeat(100) };
    assert.equal((await call('PUT', '/api/me/history/a', { token, body: edge })).status, 204);
  });
});

test('import carries episodes, drops invalid ep, and an older import does not overwrite', async () => {
  await withApi({}, async ({ call }) => {
    const { token } = await signup(call);
    const ep = (n) => ({ serverName: 'S', episodeKey: 'tap-' + n, episodeName: 'Tập ' + n });
    const res = await call('POST', '/api/me/import', { token, body: { history: [
      { slug: 'a', savedAt: '2026-05-01T00:00:00Z', ep: ep(3) },
      { slug: 'b', savedAt: '2026-05-01T00:00:00Z', ep: { episodeKey: 'only-key' } }
    ] } });
    assert.equal(res.status, 200);
    assert.equal(res.json.history, 2);
    const find = async (slug) => (await call('GET', '/api/me/history', { token })).json.items.find((x) => x.slug === slug);
    assert.equal((await find('a')).episodeKey, 'tap-3');
    assert.equal((await find('b')).episodeKey, null);
    await call('POST', '/api/me/import', { token, body: { history: [{ slug: 'a', savedAt: '2026-01-01T00:00:00Z', ep: ep(1) }] } });
    const a = await find('a');
    assert.equal(a.episodeKey, 'tap-3');
    assert.equal(a.watchedAt, '2026-05-01T00:00:00.000Z');
    await call('POST', '/api/me/import', { token, body: { history: [{ slug: 'a', savedAt: '2026-06-01T00:00:00Z', ep: ep(9) }] } });
    assert.equal((await find('a')).episodeKey, 'tap-9');
  });
});

test('progress and continue-watching routes are gone', async () => {
  await withApi({}, async ({ call }) => {
    const { token } = await signup(call);
    assert.equal((await call('PUT', '/api/me/progress', { token, body: {} })).status, 404);
    assert.equal((await call('DELETE', '/api/me/progress/a', { token })).status, 404);
    assert.equal((await call('GET', '/api/me/continue-watching', { token })).status, 404);
  });
});

test('touchHistory SQL keeps stored episode columns when ep is null', async () => {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ movie_id: 'm' }] }; };
  try {
    assert.equal(await meRepository.touchHistory('u', 'a'), true);
    assert.deepEqual(calls[0].params, ['u', 'a', null, null, null]);
    assert.match(calls[0].sql, /COALESCE\(EXCLUDED\.episode_key, user_history\.episode_key\)/);
    await meRepository.touchHistory('u', 'a', { serverName: 'S', episodeKey: 'k', episodeName: 'N' });
    assert.deepEqual(calls[1].params, ['u', 'a', 'S', 'k', 'N']);
  } finally { pool.query = original; }
});

// ---- import ----------------------------------------------------------------

test('import is idempotent, drops unknown/invalid/duplicate slugs and caps at 100 per list', async () => {
  await withApi({}, async ({ call, repo }) => {
    const { token } = await signup(call);
    const payload = {
      favorites: [{ slug: 'a', savedAt: '2026-01-01T00:00:00Z' }, { slug: 'a' }, { slug: 'ghost' }, { slug: 5 }],
      history: [{ slug: 'b' }, { slug: 'c', savedAt: 'not a date' }]
    };
    const first = await call('POST', '/api/me/import', { token, body: payload });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { favorites: 1, history: 2, skipped: 3 });
    assert.equal((await call('GET', '/api/me', { token })).json.imported, true);
    const savedAt = repo.state.favorites.get('u1').get('a').toISOString();
    assert.equal(savedAt, '2026-01-01T00:00:00.000Z');

    const second = await call('POST', '/api/me/import', { token, body: payload });
    assert.deepEqual(second.json, first.json);
    assert.equal(repo.state.favorites.get('u1').size, 1);
    assert.equal(repo.state.history.get('u1').size, 2);

    const oversized = Array.from({ length: 150 }, (_, i) => ({ slug: 'p' + i }));
    const captured = [];
    const original = repo.importUserData;
    repo.importUserData = async (...args) => { captured.push(args); return original(...args); };
    const capped = await call('POST', '/api/me/import', { token, body: { favorites: oversized, history: [] } });
    assert.equal(captured[0][1].length, 100);
    assert.equal(capped.json.skipped, 50 + 100);
    assert.equal((await call('POST', '/api/me/import', { body: payload })).status, 401);
  });
});

test('importUserData SQL is one transaction that never overwrites existing favorites', async () => {
  const queries = [];
  const client = {
    query: async (sql) => { queries.push(sql); return { rows: [{ movie_id: 1 }] }; },
    release() {}
  };
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    const counts = await meRepository.importUserData('u', [{ slug: 'a', at: new Date() }], [{ slug: 'a', at: new Date() }]);
    assert.deepEqual(counts, { favorites: 1, history: 1 });
    assert.equal(queries[0], 'BEGIN');
    assert.equal(queries.at(-1), 'COMMIT');
    assert.match(queries[1], /user_favorites.*ON CONFLICT \(user_id, movie_id\) DO UPDATE SET user_id=user_favorites\.user_id/s);
    assert.match(queries[2], /GREATEST\(user_history\.watched_at/);
    assert.match(queries[2], /EXCLUDED\.watched_at > user_history\.watched_at/);
  } finally { pool.connect = original; }
});

// ---- load ------------------------------------------------------------------

test('200 concurrent verifyPassword through the gate leave the threadpool responsive (fs.stat < 800 ms)', async () => {
  const stored = await hashPassword('correct horse');
  const flood = Promise.allSettled(Array.from({ length: 200 }, () => verifyPassword('correct horse', stored)));
  const worst = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await fs.stat(new URL(import.meta.url));
    worst.push(performance.now() - started);
    await tick(20);
  }
  const settled = await flood;
  const refused = settled.filter((r) => r.status === 'rejected');
  assert.ok(refused.every((r) => r.reason instanceof AuthOverloadedError));
  assert.ok(settled.some((r) => r.status === 'fulfilled' && r.value === true));
  assert.ok(refused.length > 0, 'excess load is shed, not queued');
  console.log('fs.stat under flood (ms):', worst.map((n) => n.toFixed(1)).join(' '));
  assert.ok(Math.max(...worst) < 800, 'fs.stat waited ' + Math.max(...worst) + ' ms');
});

test('register requires a valid Turnstile token when a secret is configured', async () => {
  const seen = [];
  const verifier = (result) => ({ enabled: true, verify: async (token, ip) => { seen.push([token, ip]); return result; } });
  const body = (token) => ({ email: 'ts@example.com', password: 'correct horse', ...(token ? { turnstileToken: token } : {}) });

  await withApi({ handler: { turnstile: verifier({ ok: false }) } }, async ({ call, repo }) => {
    const denied = await call('POST', '/api/auth/register', { body: body('bad'), headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error, 'captcha_failed');
    assert.deepEqual(seen[0], ['bad', '9.9.9.9']);
  });
  await withApi({ handler: { turnstile: verifier({ ok: false, unavailable: true }) } }, async ({ call }) => {
    const down = await call('POST', '/api/auth/register', { body: body('t') });
    assert.equal(down.status, 503);
    assert.equal(down.json.error, 'busy');
    assert.equal(down.headers.get('retry-after'), '2');
  });
  await withApi({ handler: { turnstile: verifier({ ok: true }) } }, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/register', { body: body('good') })).status, 201);
  });
  await withApi({ handler: { turnstile: { enabled: false, verify: async () => { throw new Error('must not run'); } } } }, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/register', { body: body() })).status, 201);
  });
});

test('turnstile verifier posts secret+token to siteverify and maps outcomes', async () => {
  const { createTurnstileVerifier } = await import('../src/turnstile.js');
  const calls = [];
  const make = (fetchImpl, secret = 's3cret') => createTurnstileVerifier({ secret, fetchImpl, logger: { warn() {} } });
  const ok = make(async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ success: true }) }; });
  assert.deepEqual(await ok.verify('tok', '1.2.3.4'), { ok: true });
  assert.equal(calls[0][0], 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.deepEqual(calls[0][1], { secret: 's3cret', response: 'tok', remoteip: '1.2.3.4' });
  assert.deepEqual(await make(async () => ({ ok: true, json: async () => ({ success: false }) })).verify('tok'), { ok: false });
  assert.deepEqual(await ok.verify('', '1.2.3.4'), { ok: false });
  assert.deepEqual(await ok.verify('x'.repeat(3000)), { ok: false });
  assert.deepEqual(await make(async () => { throw new Error('net'); }).verify('tok'), { ok: false, unavailable: true });
  assert.equal(make(async () => ({}), '').enabled, false);
});
