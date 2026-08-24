import { statfs } from 'node:fs/promises';
import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { createLocalImageStore } from './imageStore.js';

/**
 * Image cache prewarming.
 *
 * The API builds a cache entry lazily, on the first request for an asset:
 * fetch upstream, transcode with sharp, write the webp. Cloudflare then holds
 * that entry for a year, so the origin almost never sees a second request for
 * the same asset — which means the cost of a miss lands, in full, on whichever
 * visitor happened to arrive first.
 *
 * This module moves that cost off the visitor's critical path by asking the
 * API for the artwork the home/list viewmodels are about to serve. It owns no
 * cache of its own: the disk check reuses the API's own store module, and the
 * fetch/transcode/write is done by the API through its normal `/i/` path, so
 * there is exactly one place where a cache entry is created.
 */

// Path-only asset URLs as emitted by viewmodels.js `imageUrl()`. The legacy
// signed `/i/<variant>/<sha256>.webp?url=...` form is deliberately not matched:
// nothing in the current catalog response emits it.
const assetUrlPattern =
  /\/i\/([md])\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.webp(?:$|[?#])/i;

/**
 * Collect the distinct image assets referenced by catalog payloads, in the
 * order they appear — hero artwork first, then the rows below it, so a run
 * truncated by `limit` still warms what is most visible.
 */
export function collectImageTargets(payloads, limit = Infinity) {
  const targets = new Map();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const value of Object.values(node)) {
      if (typeof value !== 'string') {
        visit(value);
        continue;
      }
      const match = value.match(assetUrlPattern);
      if (!match) continue;
      const variant = match[1].toLowerCase();
      const assetId = match[2].toLowerCase();
      const key = variant + ':' + assetId;
      if (!targets.has(key)) targets.set(key, { variant, assetId, key });
    }
  }

  for (const payload of payloads) visit(payload);
  return [...targets.values()].slice(0, limit);
}

// 404 means the asset row is gone and 403 means the host is not allowed:
// both answer the same way on a retry, so only transient failures are retried.
function retryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function warmTarget(target, options) {
  const url = options.originUrl + '/i/' + target.variant + '/' + target.assetId + '.webp';
  let error = 'unknown';

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (attempt > 0) await options.sleep(options.retryBaseMs * (2 ** (attempt - 1)));
    try {
      // HEAD still runs the full build path in the API but transfers no bytes.
      const response = await options.fetchImpl(url, {
        method: 'HEAD',
        headers: { 'user-agent': 'BlueflareImagePrewarm/1.0' },
        signal: AbortSignal.timeout(options.timeoutMs)
      });
      if (response.ok) {
        return {
          outcome: 'warmed',
          bytes: Number(response.headers.get('content-length')) || 0
        };
      }
      error = 'HTTP ' + response.status;
      if (!retryable(response.status)) break;
    } catch (cause) {
      error = cause?.name === 'TimeoutError' ? 'timeout' : String(cause?.message || cause);
    }
  }

  return { outcome: 'failed', bytes: 0, error };
}

async function availableBytes(directory) {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
}

/**
 * Warm every asset the given catalog payloads reference that is not on disk
 * yet. Safe to call on every sync cycle: once the hot set is cached the run
 * costs one `stat()` per asset and issues no requests at all.
 */
export async function prewarmImages(payloads, options = {}) {
  const startedAt = Date.now();
  const settings = {
    store: options.store || createLocalImageStore(config.imageCacheDir),
    fetchImpl: options.fetchImpl || fetch,
    freeBytes: options.freeBytes || availableBytes,
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    cacheDir: options.cacheDir || config.imageCacheDir,
    limit: options.limit ?? config.imagePrewarmLimit,
    concurrency: options.concurrency ?? config.imagePrewarmConcurrency,
    originUrl: options.originUrl || config.imageOriginUrl,
    minFreeBytes: options.minFreeBytes ?? config.imagePrewarmMinFreeBytes,
    timeoutMs: options.timeoutMs ?? config.imagePrewarmTimeoutMs,
    retries: options.retries ?? config.imagePrewarmRetries,
    retryBaseMs: options.retryBaseMs ?? config.imagePrewarmRetryBaseMs
  };

  const targets = collectImageTargets(payloads, settings.limit);
  const stats = {
    selected: targets.length,
    cached: 0,
    warmed: 0,
    failed: 0,
    bytes: 0,
    errors: {},
    declined: null,
    durationMs: 0
  };
  const done = () => {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  };
  if (!targets.length) return done();

  let freeBytes;
  try {
    freeBytes = await settings.freeBytes(settings.cacheDir);
  } catch (error) {
    // Almost always the image cache directory not being mounted into this
    // container. Declining beats warming blind: without the disk check every
    // run would re-request the whole hot set from the API.
    stats.declined = 'cache-dir-unreadable: ' + String(error?.message || error);
    return done();
  }
  if (freeBytes < settings.minFreeBytes) {
    stats.declined = 'low-disk: ' + freeBytes + ' bytes free';
    return done();
  }

  const misses = [];
  for (const target of targets) {
    if (await settings.store.find(target.variant, target.assetId)) stats.cached += 1;
    else misses.push(target);
  }

  const results = await mapLimit(
    misses,
    settings.concurrency,
    (target) => warmTarget(target, settings)
  );
  for (const result of results) {
    if (result.outcome === 'warmed') {
      stats.warmed += 1;
      stats.bytes += result.bytes;
      continue;
    }
    stats.failed += 1;
    stats.errors[result.error] = (stats.errors[result.error] || 0) + 1;
  }
  return done();
}

export function formatPrewarmStats(stats) {
  const parts = [
    'selected=' + stats.selected,
    'cached=' + stats.cached,
    'warmed=' + stats.warmed,
    'failed=' + stats.failed,
    'bytes=' + stats.bytes,
    'durationMs=' + stats.durationMs
  ];
  if (stats.declined) parts.push('declined=' + stats.declined);
  const errors = Object.entries(stats.errors);
  if (errors.length) {
    parts.push('errors=' + errors.map(([reason, count]) => reason + 'x' + count).join(','));
  }
  return parts.join(' ');
}
