import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  createWorkerHeartbeat,
  parseWorkerHeartbeat,
  workerHeartbeatKey
} from './workerHealth.js';

let client;
let connecting;
const inFlight = new Map();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function redis() {
  if (client?.isReady) return client;
  if (connecting) return connecting;

  client = createClient({ url: config.redisUrl });
  client.on('error', (error) => {
    console.error('[valkey] connection error', error.message);
  });
  connecting = client.connect()
    .then(() => client)
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

export async function cacheVersion() {
  try {
    return (await (await redis()).get('catalog:version')) || '1';
  } catch {
    return '1';
  }
}

export async function bumpCacheVersion() {
  try {
    return String(await (await redis()).incr('catalog:version'));
  } catch (error) {
    console.error('[valkey] could not bump catalog version', error.message);
    return String(Date.now());
  }
}

async function readCached(versionedKey) {
  try {
    const raw = await (await redis()).get(versionedKey);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('[valkey] read failed', error.message);
    return null;
  }
}

async function writeCached(versionedKey, data, ttl, staleTtl) {
  const envelope = { data, freshUntil: Date.now() + (ttl * 1000) };
  try {
    await (await redis()).set(versionedKey, JSON.stringify(envelope), { EX: ttl + staleTtl });
  } catch (error) {
    console.error('[valkey] write failed', error.message);
  }
}

async function releaseLock(lockKey, token) {
  try {
    await (await redis()).sendCommand(['EVAL', 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', '1', lockKey, token]);
  } catch (error) {
    console.error('[valkey] lock release failed', error.message);
  }
}

async function buildValue(versionedKey, builder, ttl, staleTtl, cached) {
  const existing = inFlight.get(versionedKey);
  if (existing) return existing;
  const promise = (async () => {
    const lockKey = versionedKey + ':lock';
    const token = randomUUID();
    let lockHeld = false;
    try {
      try { lockHeld = Boolean(await (await redis()).set(lockKey, token, { NX: true, EX: 30 })); }
      catch (error) { console.error('[valkey] lock acquire failed', error.message); }
      if (!lockHeld) {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await sleep(100);
          const refreshed = await readCached(versionedKey);
          if (refreshed && refreshed.freshUntil > Date.now()) return { data: refreshed.data, cacheStatus: 'VALKEY-HIT-AFTER-LOCK' };
        }
        if (cached) return { data: cached.data, cacheStatus: 'VALKEY-STALE-SERVED' };
      }
      const data = await builder();
      await writeCached(versionedKey, data, ttl, staleTtl);
      return { data, cacheStatus: cached ? 'VALKEY-REFRESH' : 'POSTGRES' };
    } finally { if (lockHeld) await releaseLock(lockKey, token); }
  })();
  inFlight.set(versionedKey, promise);
  try { return await promise; } finally { inFlight.delete(versionedKey); }
}

function refreshInBackground(versionedKey, builder, ttl, staleTtl, cached) {
  void buildValue(versionedKey, builder, ttl, staleTtl, cached).catch((error) => console.error('[valkey] background refresh failed', error.message));
}

export async function getOrBuild(key, builder, options = {}) {
  const ttl = options.ttl || config.responseCacheTtlSeconds;
  const staleTtl = options.staleTtl || config.responseCacheStaleSeconds;
  const version = options.version || await cacheVersion();
  const versionedKey = 'response:v' + version + ':' + key;
  const cached = await readCached(versionedKey);
  if (cached && cached.freshUntil > Date.now()) return { data: cached.data, cacheStatus: 'VALKEY-HIT' };
  if (cached) { refreshInBackground(versionedKey, builder, ttl, staleTtl, cached); return { data: cached.data, cacheStatus: 'VALKEY-STALE-SERVED' }; }
  return buildValue(versionedKey, builder, ttl, staleTtl, cached);
}

export async function invalidateResponseKeys(keys = []) {
  const normalized = [...new Set(keys.filter(Boolean).map(String))];
  if (!normalized.length) return 0;
  try {
    const version = await cacheVersion();
    const result = await (await redis()).del(...normalized.map((key) => 'response:v' + version + ':' + key));
    return Number(result) || 0;
  } catch (error) { console.error('[valkey] invalidation failed', error.message); return 0; }
}

export async function writeWorkerHeartbeat(status, details = {}) {
  const heartbeat = createWorkerHeartbeat(status, details);
  try {
    await (await redis()).set(workerHeartbeatKey, JSON.stringify(heartbeat), {
      EX: config.workerHeartbeatTtlSeconds
    });
    return heartbeat;
  } catch (error) {
    console.error('[valkey] worker heartbeat write failed', error.message);
    return null;
  }
}

export async function readWorkerHeartbeat() {
  try {
    return parseWorkerHeartbeat(await (await redis()).get(workerHeartbeatKey));
  } catch (error) {
    console.error('[valkey] worker heartbeat read failed', error.message);
    return null;
  }
}

export async function redisHealth() {
  const started = Date.now();
  const result = await (await redis()).ping();
  return { ok: result === 'PONG', latencyMs: Date.now() - started };
}

export async function closeCache() {
  if (client?.isOpen) await client.quit();
}
