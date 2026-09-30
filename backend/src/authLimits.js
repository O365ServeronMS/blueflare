import { createHash } from 'node:crypto';
import { RateLimiter } from './auth.js';

const VALKEY_TIMEOUT_MS = 100;
// After a Valkey failure, go straight to memory for this long so a dead Valkey
// does not add its timeout to every login.
const VALKEY_BACKOFF_MS = 5000;

class Timeout extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Timeout('valkey timeout')), ms); });
  // The losing side may still reject later; that must not become unhandled.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fixed-window counters. Valkey is the shared, restart-proof store; any Valkey
 * error or a reply slower than 100 ms falls back (fail-open, logged) to the
 * in-process RateLimiter so authentication itself never breaks. Keys hold only
 * sha256(identifier), never a raw email or IP.
 */
export function createAuthLimits({
  getClient,
  now = Date.now,
  logger = console,
  timeoutMs = VALKEY_TIMEOUT_MS,
  backoffMs = VALKEY_BACKOFF_MS,
  clock = Date.now
} = {}) {
  const memory = new Map();
  let skipValkeyUntil = 0;

  function limiterFor(bucket, limit, windowSec) {
    const id = `${bucket}:${limit}:${windowSec}`;
    let limiter = memory.get(id);
    if (!limiter) {
      limiter = new RateLimiter({ limit, windowMs: windowSec * 1000, now });
      memory.set(id, limiter);
    }
    return limiter;
  }

  function redisKey(bucket, key) {
    return `auth:rl:${bucket}:${createHash('sha256').update(String(key)).digest('hex')}`;
  }

  function failOpen(error) {
    if (clock() >= skipValkeyUntil) {
      logger.warn?.('[auth] rate-limit store unavailable, using memory counters:', error.message);
    }
    skipValkeyUntil = clock() + backoffMs;
  }

  async function viaValkey(operation) {
    if (!getClient || clock() < skipValkeyUntil) return null;
    try {
      return await withTimeout((async () => operation(await getClient()))(), timeoutMs);
    } catch (error) {
      failOpen(error);
      return null;
    }
  }

  async function retryAfter(client, redisName, windowSec) {
    const ttl = Number(await client.ttl(redisName));
    if (ttl > 0) return ttl;
    // No TTL (e.g. a crash between INCR and EXPIRE): repair it so the key cannot stick.
    await client.expire(redisName, windowSec);
    return windowSec;
  }

  /** Records one hit. Returns { allowed, retryAfterSeconds }. */
  async function take(bucket, key, limit, windowSec) {
    const name = redisKey(bucket, key);
    const result = await viaValkey(async (client) => {
      const count = Number(await client.incr(name));
      if (count === 1) await client.expire(name, windowSec);
      if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: await retryAfter(client, name, windowSec) };
    });
    return result || limiterFor(bucket, limit, windowSec).take(String(key));
  }

  /** Same decision as take() without recording a hit. */
  async function peek(bucket, key, limit, windowSec) {
    const name = redisKey(bucket, key);
    const result = await viaValkey(async (client) => {
      const count = Number(await client.get(name)) || 0;
      if (count < limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: await retryAfter(client, name, windowSec) };
    });
    return result || limiterFor(bucket, limit, windowSec).peek(String(key));
  }

  return { take, peek };
}
