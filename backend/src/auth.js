import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 10;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// 16 MiB per hash: enough work to make offline guessing costly while keeping a
// burst of logins from exhausting a small VPS.
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keylen, {
      N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem
    }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const params = { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length };
  if (!expected.length || !Number.isInteger(params.N) || params.N > 1 << 20) return false;
  try {
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), params);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash = null;

/** Spend the same scrypt time as a real check so unknown emails are not distinguishable. */
export async function dummyVerify(password) {
  dummyHash ||= await hashPassword('blueflare-dummy-password');
  await verifyPassword(password, dummyHash);
  return false;
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validEmail(email) {
  return email.length >= 3 && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validPassword(password) {
  return typeof password === 'string' &&
    password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

export function sessionExpiry(now = Date.now()) {
  return new Date(now + SESSION_TTL_MS);
}

/**
 * Decide what to do with a stored session. `renew` is true when the sliding
 * window should be pushed out (at most once per SESSION_RENEW_AFTER_MS).
 */
export function assessSession(session, now = Date.now()) {
  if (!session) return { valid: false, renew: false };
  const expiresAt = new Date(session.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { valid: false, renew: false };
  const renewedAt = new Date(session.renewed_at).getTime();
  const renew = !Number.isFinite(renewedAt) || now - renewedAt >= SESSION_RENEW_AFTER_MS;
  return { valid: true, renew };
}

export function bearerToken(request) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(String(request.headers.authorization || ''));
  return match ? match[1] : '';
}

/**
 * Sliding-window limiter held in process memory. One api container serves the
 * whole stack, and a restart resetting counters is an acceptable trade for not
 * adding a table or a Valkey dependency to the auth path.
 */
export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 10000, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.hits = new Map();
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) || []).filter((time) => time > cutoff);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }

  /** Records an attempt. Returns { allowed, retryAfterSeconds }. */
  take(key) {
    const recent = this.#recent(key);
    if (recent.length >= this.limit) {
      const retryMs = recent[0] + this.windowMs - this.now();
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.#prune();
    recent.push(this.now());
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #prune() {
    for (const key of [...this.hits.keys()]) this.#recent(key);
    // Still full of live keys: drop the oldest insertions rather than grow.
    while (this.hits.size >= this.maxKeys) {
      this.hits.delete(this.hits.keys().next().value);
    }
  }
}

/** Consecutive-failure counter driving the monotonic login delay. */
export class FailureTracker {
  constructor({ maxKeys = 10000, ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.maxKeys = maxKeys;
    this.ttlMs = ttlMs;
    this.now = now;
    this.failures = new Map();
  }

  count(key) {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    if (this.now() - entry.at > this.ttlMs) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count;
  }

  fail(key) {
    const count = this.count(key) + 1;
    this.failures.delete(key);
    if (this.failures.size >= this.maxKeys) {
      this.failures.delete(this.failures.keys().next().value);
    }
    this.failures.set(key, { count, at: this.now() });
    return count;
  }

  reset(key) {
    this.failures.delete(key);
  }
}

/** 0 for the first 5 failures, then 250 ms doubling up to 5 s. */
export function failureDelayMs(consecutiveFailures) {
  if (consecutiveFailures < 5) return 0;
  return Math.min(5000, 250 * 2 ** (consecutiveFailures - 5));
}
