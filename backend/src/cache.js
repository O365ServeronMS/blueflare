import { createClient } from 'redis';
import { config } from './config.js';

let client;
let connecting;

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

export async function getOrBuild(key, builder, options = {}) {
  const ttl = options.ttl || config.responseCacheTtlSeconds;
  const staleTtl = options.staleTtl || config.responseCacheStaleSeconds;
  const version = options.version || await cacheVersion();
  const versionedKey = 'response:v' + version + ':' + key;
  let cached;

  try {
    const raw = await (await redis()).get(versionedKey);
    if (raw) cached = JSON.parse(raw);
  } catch (error) {
    console.error('[valkey] read failed', error.message);
  }

  if (cached && cached.freshUntil > Date.now()) {
    return { data: cached.data, cacheStatus: 'VALKEY-HIT' };
  }

  try {
    const data = await builder();
    const envelope = {
      data,
      freshUntil: Date.now() + (ttl * 1000)
    };
    try {
      await (await redis()).set(versionedKey, JSON.stringify(envelope), {
        EX: ttl + staleTtl
      });
    } catch (error) {
      console.error('[valkey] write failed', error.message);
    }
    return {
      data,
      cacheStatus: cached ? 'VALKEY-REFRESH' : 'POSTGRES'
    };
  } catch (error) {
    if (cached) {
      return { data: cached.data, cacheStatus: 'VALKEY-STALE' };
    }
    throw error;
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
