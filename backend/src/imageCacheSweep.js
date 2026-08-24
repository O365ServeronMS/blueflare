import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Image cache caretaker.
 *
 * The cache is disposable — every entry can be rebuilt from `image_assets` —
 * but nothing ever removed one, so the only bound on its size was how much of
 * the catalog users happened to look at. This sweep gives it a ceiling.
 *
 * It runs inside the API because the API is the only process that writes this
 * directory: keeping deletion there too means a cache entry has exactly one
 * owner, and an evicted file can never be pulled out from under a writer in
 * another container. The worker's mount stays read-only.
 *
 * Two independent jobs:
 *   - orphan `.tmp` files, left behind when a build crashed between
 *     `prepareWrite()` and `rename()`, are removed once they are old enough to
 *     not belong to a build still in flight;
 *   - once the cache is over `maxBytes`, the least recently *read* entries are
 *     dropped until it is back under the target, which is the eviction order
 *     that matches how the cache is used: Cloudflare absorbs the repeats, so a
 *     file the origin has not been asked for in weeks is genuinely cold.
 */

async function collect(baseDirectory) {
  const webp = [];
  const temporary = [];
  let bytes = 0;

  const entries = await readdir(baseDirectory, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isTemporary = entry.name.endsWith('.tmp');
    if (!isTemporary && !entry.name.endsWith('.webp')) continue;

    const filename = path.join(entry.parentPath, entry.name);
    let stats;
    try {
      stats = await lstat(filename);
    } catch {
      // Raced with a concurrent build or an earlier pass; nothing to account for.
      continue;
    }
    if (!stats.isFile()) continue;

    if (isTemporary) {
      temporary.push({ filename, mtimeMs: stats.mtimeMs });
      continue;
    }
    bytes += stats.size;
    webp.push({ filename, size: stats.size, atimeMs: stats.atimeMs });
  }

  return { webp, temporary, bytes };
}

async function remove(filename) {
  try {
    await unlink(filename);
    return true;
  } catch {
    return false;
  }
}

export async function sweepImageCache(baseDirectory, options = {}) {
  const startedAt = Date.now();
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? 0;
  const targetPercent = options.targetPercent ?? 90;
  const minAgeMs = options.minAgeMs ?? 60 * 60 * 1000;
  const tmpMaxAgeMs = options.tmpMaxAgeMs ?? 60 * 60 * 1000;

  const stats = {
    files: 0,
    bytes: 0,
    evicted: 0,
    freedBytes: 0,
    tmpRemoved: 0,
    overBudget: false,
    retained: 0,
    durationMs: 0
  };
  const done = () => {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  };

  const { webp, temporary, bytes } = await collect(baseDirectory);
  stats.files = webp.length;
  stats.bytes = bytes;

  for (const entry of temporary) {
    if (now - entry.mtimeMs < tmpMaxAgeMs) continue;
    if (await remove(entry.filename)) stats.tmpRemoved += 1;
  }

  // maxBytes 0 disables eviction; the orphan-tmp pass above still runs, since
  // that is a leak rather than a policy.
  if (!maxBytes || bytes <= maxBytes) return done();
  stats.overBudget = true;

  // Drop to a target below the ceiling so the next sweep is not immediately
  // over budget again after a handful of new builds.
  const targetBytes = Math.floor(maxBytes * (targetPercent / 100));
  const candidates = webp
    .filter((entry) => now - entry.atimeMs >= minAgeMs)
    .sort((left, right) => left.atimeMs - right.atimeMs);
  stats.retained = webp.length - candidates.length;

  let remaining = bytes;
  for (const entry of candidates) {
    if (remaining <= targetBytes) break;
    if (!(await remove(entry.filename))) continue;
    remaining -= entry.size;
    stats.evicted += 1;
    stats.freedBytes += entry.size;
  }

  return done();
}

export function formatSweepStats(stats) {
  const parts = [
    'files=' + stats.files,
    'bytes=' + stats.bytes,
    'evicted=' + stats.evicted,
    'freedBytes=' + stats.freedBytes,
    'tmpRemoved=' + stats.tmpRemoved,
    'durationMs=' + stats.durationMs
  ];
  if (stats.overBudget) parts.push('overBudget=true retainedTooRecent=' + stats.retained);
  return parts.join(' ');
}
