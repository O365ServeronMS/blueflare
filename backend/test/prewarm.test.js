import assert from 'node:assert/strict';
import test from 'node:test';
import { collectImageTargets, formatPrewarmStats, prewarmImages } from '../src/prewarm.js';

const HERO_THUMB = '11111111-1111-4111-8111-111111111111';
const HERO_POSTER = '22222222-2222-4222-8222-222222222222';
const ROW_THUMB = '33333333-3333-4333-8333-333333333333';

function asset(id, variant) {
  return 'https://img.bluesia.net/i/' + variant + '/' + id + '.webp';
}

function homePayload() {
  return {
    heroMovies: [{
      slug: 'hero',
      thumb_url: asset(HERO_THUMB, 'm'),
      poster_url: asset(HERO_POSTER, 'd')
    }],
    newMovies: {
      items: [
        // Repeats the hero thumb: the same asset must only be warmed once.
        { slug: 'again', thumb_url: asset(HERO_THUMB, 'm'), poster_url: '' },
        { slug: 'row', thumb_url: asset(ROW_THUMB, 'm'), poster_url: '' }
      ]
    }
  };
}

function options(overrides = {}) {
  return {
    store: { find: async () => null },
    freeBytes: async () => 50 * 1024 * 1024 * 1024,
    sleep: async () => {},
    cacheDir: '/data/images',
    originUrl: 'http://api:3200',
    limit: 100,
    concurrency: 2,
    minFreeBytes: 1024,
    timeoutMs: 1000,
    retries: 2,
    retryBaseMs: 1,
    fetchImpl: async () => ok(),
    ...overrides
  };
}

function ok(size = 4096) {
  return { ok: true, status: 200, headers: { get: () => String(size) } };
}

function status(code) {
  return { ok: false, status: code, headers: { get: () => null } };
}

test('targets are deduplicated and keep hero-first order', () => {
  const targets = collectImageTargets([homePayload()]);
  assert.deepEqual(targets.map((target) => target.key), [
    'm:' + HERO_THUMB,
    'd:' + HERO_POSTER,
    'm:' + ROW_THUMB
  ]);
});

test('non-asset strings and the legacy signed form are ignored', () => {
  const targets = collectImageTargets([{
    slug: 'phim-hay',
    name: 'Not a URL',
    poster_url: '',
    legacy: 'https://img.bluesia.net/i/m/' + 'a'.repeat(64) + '.webp?url=x&sig=y'
  }]);
  assert.deepEqual(targets, []);
});

test('the limit truncates the tail, keeping the most visible assets', () => {
  const targets = collectImageTargets([homePayload()], 2);
  assert.deepEqual(targets.map((target) => target.key), ['m:' + HERO_THUMB, 'd:' + HERO_POSTER]);
});

test('assets already on disk are skipped without any request', async () => {
  let requests = 0;
  const stats = await prewarmImages([homePayload()], options({
    store: { find: async (variant, assetId) => '/data/images/' + variant + '/' + assetId + '.webp' },
    fetchImpl: async () => { requests += 1; return ok(); }
  }));
  assert.equal(requests, 0);
  assert.equal(stats.selected, 3);
  assert.equal(stats.cached, 3);
  assert.equal(stats.warmed, 0);
});

test('missing assets are warmed once each and their bytes counted', async () => {
  const seen = [];
  const stats = await prewarmImages([homePayload()], options({
    fetchImpl: async (url, init) => { seen.push(init.method + ' ' + url); return ok(1000); }
  }));
  assert.equal(stats.warmed, 3);
  assert.equal(stats.failed, 0);
  assert.equal(stats.bytes, 3000);
  assert.equal(seen.length, 3);
  assert.equal(seen[0], 'HEAD http://api:3200/i/m/' + HERO_THUMB + '.webp');
});

test('a transient 503 is retried and can still succeed', async () => {
  let attempts = 0;
  const stats = await prewarmImages([{ thumb_url: asset(ROW_THUMB, 'm') }], options({
    fetchImpl: async () => { attempts += 1; return attempts < 3 ? status(503) : ok(); }
  }));
  assert.equal(attempts, 3);
  assert.equal(stats.warmed, 1);
});

test('a 404 is not retried and is reported as a failure', async () => {
  let attempts = 0;
  const stats = await prewarmImages([{ thumb_url: asset(ROW_THUMB, 'm') }], options({
    fetchImpl: async () => { attempts += 1; return status(404); }
  }));
  assert.equal(attempts, 1);
  assert.equal(stats.failed, 1);
  assert.deepEqual(stats.errors, { 'HTTP 404': 1 });
});

test('retries are exhausted on a persistent 429', async () => {
  let attempts = 0;
  const stats = await prewarmImages([{ thumb_url: asset(ROW_THUMB, 'm') }], options({
    retries: 2,
    fetchImpl: async () => { attempts += 1; return status(429); }
  }));
  assert.equal(attempts, 3);
  assert.equal(stats.failed, 1);
});

test('a thrown network error is captured rather than aborting the run', async () => {
  const stats = await prewarmImages([homePayload()], options({
    retries: 0,
    fetchImpl: async (url) => {
      if (url.includes(HERO_POSTER)) throw new Error('socket hang up');
      return ok();
    }
  }));
  assert.equal(stats.warmed, 2);
  assert.equal(stats.failed, 1);
  assert.deepEqual(stats.errors, { 'socket hang up': 1 });
});

test('a low disk reading declines the run before any request', async () => {
  let requests = 0;
  const stats = await prewarmImages([homePayload()], options({
    freeBytes: async () => 512,
    minFreeBytes: 1024,
    fetchImpl: async () => { requests += 1; return ok(); }
  }));
  assert.equal(requests, 0);
  assert.match(stats.declined, /^low-disk: 512 bytes free$/);
});

test('an unreadable cache directory declines instead of warming blind', async () => {
  let requests = 0;
  const stats = await prewarmImages([homePayload()], options({
    freeBytes: async () => { throw new Error('ENOENT: no such file or directory'); },
    fetchImpl: async () => { requests += 1; return ok(); }
  }));
  assert.equal(requests, 0);
  assert.match(stats.declined, /^cache-dir-unreadable: ENOENT/);
});

test('a payload with no artwork does no work at all', async () => {
  let probes = 0;
  const stats = await prewarmImages([{ items: [] }], options({
    freeBytes: async () => { probes += 1; return 0; }
  }));
  assert.equal(probes, 0);
  assert.equal(stats.selected, 0);
  assert.equal(stats.declined, null);
});

test('the log line carries every counter a run should report', () => {
  const line = formatPrewarmStats({
    selected: 200, cached: 143, warmed: 52, failed: 5, bytes: 2048,
    errors: { 'HTTP 404': 5 }, declined: null, durationMs: 18400
  });
  assert.equal(
    line,
    'selected=200 cached=143 warmed=52 failed=5 bytes=2048 durationMs=18400 errors=HTTP 404x5'
  );
});
