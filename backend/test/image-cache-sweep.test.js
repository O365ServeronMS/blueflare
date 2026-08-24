import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatSweepStats, sweepImageCache } from '../src/imageCacheSweep.js';

const HOUR = 60 * 60 * 1000;

async function cacheDir() {
  return mkdtemp(path.join(os.tmpdir(), 'blueflare-sweep-'));
}

// Mirrors the real layout: /<variant>/<2 char shard>/<name>.
async function put(base, variant, name, { size = 1000, ageMs = 0 } = {}) {
  const directory = path.join(base, variant, name.slice(0, 2));
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, name);
  await writeFile(filename, Buffer.alloc(size));
  const when = new Date(Date.now() - ageMs);
  await utimes(filename, when, when);
  return filename;
}

async function survivors(base) {
  const entries = await readdir(base, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

test('a cache under its ceiling is left completely alone', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'aa1.webp', { size: 500, ageMs: 90 * 24 * HOUR });
  await put(base, 'd', 'bb1.webp', { size: 500, ageMs: 90 * 24 * HOUR });

  const stats = await sweepImageCache(base, { maxBytes: 10000 });
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, 1000);
  assert.equal(stats.evicted, 0);
  assert.equal(stats.overBudget, false);
  assert.deepEqual(await survivors(base), ['aa1.webp', 'bb1.webp']);
});

test('eviction drops least-recently-read entries down to the target', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'old1.webp', { size: 1000, ageMs: 30 * 24 * HOUR });
  await put(base, 'm', 'old2.webp', { size: 1000, ageMs: 20 * 24 * HOUR });
  await put(base, 'm', 'mid1.webp', { size: 1000, ageMs: 10 * 24 * HOUR });
  await put(base, 'm', 'new1.webp', { size: 1000, ageMs: 5 * 24 * HOUR });

  // 4000 bytes over a 2000 ceiling, target 50% -> must reach <= 1000.
  const stats = await sweepImageCache(base, {
    maxBytes: 2000, targetPercent: 50, minAgeMs: HOUR
  });
  assert.equal(stats.overBudget, true);
  assert.equal(stats.evicted, 3);
  assert.equal(stats.freedBytes, 3000);
  assert.deepEqual(await survivors(base), ['new1.webp']);
});

test('entries read within the minimum age are never evicted', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'hot1.webp', { size: 5000, ageMs: 60 * 1000 });
  await put(base, 'm', 'hot2.webp', { size: 5000, ageMs: 60 * 1000 });

  const stats = await sweepImageCache(base, {
    maxBytes: 1000, targetPercent: 50, minAgeMs: HOUR
  });
  assert.equal(stats.overBudget, true);
  assert.equal(stats.evicted, 0);
  assert.equal(stats.retained, 2);
  assert.deepEqual(await survivors(base), ['hot1.webp', 'hot2.webp']);
});

test('orphan .tmp files past their age are removed, fresh ones kept', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'ab.123.tmp', { size: 100, ageMs: 3 * HOUR });
  await put(base, 'm', 'cd.456.tmp', { size: 100, ageMs: 60 * 1000 });
  await put(base, 'm', 'ef1.webp', { size: 100, ageMs: 0 });

  const stats = await sweepImageCache(base, { maxBytes: 0, tmpMaxAgeMs: HOUR });
  assert.equal(stats.tmpRemoved, 1);
  assert.deepEqual(await survivors(base), ['cd.456.tmp', 'ef1.webp']);
});

// .tmp files are a leak, not a policy: they are swept even with eviction off.
test('maxBytes 0 disables eviction but still sweeps orphan .tmp files', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'aa1.webp', { size: 9999, ageMs: 90 * 24 * HOUR });
  await put(base, 'm', 'bb.7.tmp', { size: 10, ageMs: 3 * HOUR });

  const stats = await sweepImageCache(base, { maxBytes: 0, tmpMaxAgeMs: HOUR });
  assert.equal(stats.evicted, 0);
  assert.equal(stats.overBudget, false);
  assert.equal(stats.tmpRemoved, 1);
  assert.deepEqual(await survivors(base), ['aa1.webp']);
});

test('.tmp bytes are not counted against the cache budget', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'aa1.webp', { size: 100, ageMs: 0 });
  await put(base, 'm', 'bb.7.tmp', { size: 100000, ageMs: 0 });

  const stats = await sweepImageCache(base, { maxBytes: 1000 });
  assert.equal(stats.bytes, 100);
  assert.equal(stats.files, 1);
  assert.equal(stats.overBudget, false);
});

test('unrelated files are neither counted nor deleted', async () => {
  const base = await cacheDir();
  await put(base, 'm', 'aa1.webp', { size: 100, ageMs: 90 * 24 * HOUR });
  await put(base, 'm', 'aa-README', { size: 100, ageMs: 90 * 24 * HOUR });

  const stats = await sweepImageCache(base, { maxBytes: 1, targetPercent: 50, minAgeMs: HOUR });
  assert.equal(stats.files, 1);
  assert.equal(stats.evicted, 1);
  assert.deepEqual(await survivors(base), ['aa-README']);
});

test('an empty cache directory sweeps cleanly', async () => {
  const base = await cacheDir();
  const stats = await sweepImageCache(base, { maxBytes: 1000 });
  assert.equal(stats.files, 0);
  assert.equal(stats.bytes, 0);
  assert.equal(stats.evicted, 0);
});

test('eviction stops as soon as the target is met', async () => {
  const base = await cacheDir();
  for (let index = 0; index < 10; index += 1) {
    await put(base, 'm', 'f' + index + '.webp', { size: 100, ageMs: (20 - index) * 24 * HOUR });
  }
  // 1000 bytes, ceiling 900, target 80% -> stop at <= 720, i.e. drop 3.
  const stats = await sweepImageCache(base, {
    maxBytes: 900, targetPercent: 80, minAgeMs: HOUR
  });
  assert.equal(stats.evicted, 3);
  const left = await survivors(base);
  assert.equal(left.length, 7);
  assert.equal(left.includes('f0.webp'), false, 'coldest entry should be gone');
  assert.equal(left.includes('f9.webp'), true, 'hottest entry should survive');
});

test('the sweep log line reports every counter', () => {
  const line = formatSweepStats({
    files: 1408, bytes: 66000000, evicted: 0, freedBytes: 0,
    tmpRemoved: 0, overBudget: false, retained: 0, durationMs: 42
  });
  assert.equal(
    line,
    'files=1408 bytes=66000000 evicted=0 freedBytes=0 tmpRemoved=0 durationMs=42'
  );
});
