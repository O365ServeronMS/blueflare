import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { reviewCard } from '../src/reviewOrder.js';
import {
  TranslateBlockedError,
  createTranslator,
  googleGtxProvider,
  parseGtxResponse,
  planChunks,
  splitIntoChunks
} from '../src/translate.js';
import { syncReviewTranslations } from '../src/reviewTranslateSync.js';
import {
  listPendingReviewTranslations,
  recordReviewTranslation,
  reviewsForMovie,
  recordTmdbReviews
} from '../src/repository.js';
import { buildReviews } from '../src/viewmodels.js';

test('chunking: short text is one chunk, long text splits on paragraphs then sentences, all <= max', () => {
  assert.deepEqual(splitIntoChunks('Hello there.'), ['Hello there.']);
  const para = 'First sentence is here. Second sentence follows! Third one? ';
  const text = (para.repeat(40) + '\n').repeat(3) + 'Tail.';
  const chunks = splitIntoChunks(text, 500);
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 500, String(chunk.length));
  // A single word run longer than max is hard cut.
  for (const chunk of splitIntoChunks('x'.repeat(1050), 400)) assert.ok(chunk.length <= 400);
});

test('chunking: paragraph breaks survive a round trip through the planner', () => {
  const text = 'Alpha one. Alpha two.\n\nBeta one. Beta two.\nGamma.';
  const rebuilt = planChunks(text, 25).map((c) => c.joiner + c.text).join('');
  assert.equal(rebuilt, text);
  assert.equal(planChunks(text).length, 1);
});

test('parseGtxResponse: joins segments, rejects bad shapes', () => {
  assert.equal(parseGtxResponse([[['Xin chao. ', 'Hello. ', null], ['The gioi\n', 'World\n']], null, 'en']), 'Xin chao. The gioi\n');
  assert.throws(() => parseGtxResponse({}), /shape/);
  assert.throws(() => parseGtxResponse([null]), /shape/);
});

const res = (status, body, type = 'application/json') => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: () => type },
  text: async () => body
});

test('gtx provider: POST form body, parses, detects blocked responses', async () => {
  let seen;
  const ok = googleGtxProvider({ timeoutMs: 1000, fetchImpl: async (url, init) => { seen = { url, init }; return res(200, JSON.stringify([[['Chao', 'Hi']]])); } });
  assert.equal(await ok('Hi & bye'), 'Chao');
  assert.match(seen.url, /translate_a\/single\?client=gtx&sl=en&tl=vi&dt=t/);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, 'q=' + encodeURIComponent('Hi & bye'));
  for (const response of [res(429, ''), res(403, ''), res(200, '<html>captcha</html>', 'text/html'), res(200, '  <!doctype html>')]) {
    const p = googleGtxProvider({ timeoutMs: 1000, fetchImpl: async () => response });
    await assert.rejects(p('x'), (e) => e instanceof TranslateBlockedError && e.blocked === true);
  }
  const bad = googleGtxProvider({ timeoutMs: 1000, fetchImpl: async () => res(500, 'no') });
  await assert.rejects(bad('x'), (e) => !e.blocked && e.status === 500);
});

test('translator: retries transient errors with backoff, never retries blocked, keeps breaks', async () => {
  const sleeps = [];
  let calls = 0;
  const translate = createTranslator({
    chunkFn: async (t) => { calls += 1; if (calls < 3) throw new Error('flaky'); return 'VI(' + t + ')'; },
    sleep: async (ms) => { sleeps.push(ms); }, backoffMs: 10
  });
  assert.equal(await translate('a\nb'), 'VI(a\nb)');
  assert.deepEqual(sleeps, [10, 20]);

  let blockedCalls = 0;
  const blocked = createTranslator({ chunkFn: async () => { blockedCalls += 1; throw new TranslateBlockedError('b'); }, sleep: async () => {} });
  await assert.rejects(blocked('x'), (e) => e.blocked);
  assert.equal(blockedCalls, 1);

  const multi = createTranslator({ chunkFn: async (t) => t.toUpperCase(), chunkMax: 10 });
  assert.equal(await multi('aaa bbb.\n\nccc ddd. eee fff.'), 'AAA BBB.\n\nCCC DDD. EEE FFF.');
  await assert.rejects(async () => createTranslator({ provider: 'nope' }), /unknown/);
});

const cfg = { translateEnabled: true, translateProvider: 'google-gtx', translateReviewsPerCycle: 10, translateDelayMs: 5, translateMaxConsecutiveErrors: 3, translateCooldownMs: 1000, translateTimeoutMs: 1000 };
const pend = (n) => Array.from({ length: n }, (_, i) => ({ id: 'r' + i, slug: 's' + (i % 2), content: 'text ' + i, contentHash: 'h' + i }));

function harness(overrides = {}) {
  const log = { recorded: [], failed: [], sleeps: [], time: 1000 };
  const deps = {
    config: cfg, state: { cooldownUntil: 0 }, now: () => log.time,
    sleep: async (ms) => { log.sleeps.push(ms); },
    listPending: async () => pend(6),
    translate: async (t) => 'VI ' + t,
    record: async (id, hash, value) => { log.recorded.push({ id, hash, value }); return true; },
    recordFailure: async (id, o) => { log.failed.push({ id, retryMs: o.retryMs }); },
    ...overrides
  };
  return { deps, log };
}

test('sync: translates sequentially with spacing, returns changed slugs, stores source hash', async () => {
  const { deps, log } = harness();
  const changed = await syncReviewTranslations(deps);
  assert.deepEqual(changed.sort(), ['s0', 's1']);
  assert.equal(log.recorded.length, 6);
  assert.deepEqual(log.recorded[2], { id: 'r2', hash: 'h2', value: 'VI text 2' });
  assert.equal(log.sleeps.length, 5);
});

test('sync: disabled, nothing pending, and echoed text', async () => {
  const off = harness();
  off.deps.config = { ...cfg, translateEnabled: false };
  assert.deepEqual(await syncReviewTranslations(off.deps), []);
  const none = harness({ listPending: async () => [] });
  assert.deepEqual(await syncReviewTranslations(none.deps), []);
  const same = harness({ listPending: async () => pend(1), translate: async (t) => t });
  assert.deepEqual(await syncReviewTranslations(same.deps), []);
  assert.deepEqual(same.log.recorded, [{ id: 'r0', hash: 'h0', value: '' }]);
});

test('circuit breaker: consecutive errors stop the pass and open the cooldown', async () => {
  const { deps, log } = harness({ translate: async () => { throw new Error('boom'); } });
  assert.deepEqual(await syncReviewTranslations(deps), []);
  assert.equal(log.failed.length, 3);
  assert.deepEqual(log.failed[0], { id: 'r0', retryMs: 1000 });
  assert.equal(deps.state.cooldownUntil, 2000);
  // Cooldown: next cycle does not even list.
  let listed = 0;
  deps.listPending = async () => { listed += 1; return pend(2); };
  await syncReviewTranslations(deps);
  assert.equal(listed, 0);
  log.time = 2000;
  await syncReviewTranslations(deps);
  assert.equal(listed, 1);
});

test('circuit breaker: a success resets the error streak; blocked stops at once without marking the review', async () => {
  let n = 0;
  const flaky = harness({ translate: async (t) => { n += 1; if (n % 3 !== 0) throw new Error('x'); return 'ok ' + t; } });
  await syncReviewTranslations(flaky.deps);
  assert.equal(flaky.log.recorded.length, 2);
  assert.equal(flaky.deps.state.cooldownUntil, 0);

  let m = 0;
  const blocked = harness({ translate: async (t) => { m += 1; if (m === 3) throw new TranslateBlockedError('429'); return 'ok ' + t; } });
  await syncReviewTranslations(blocked.deps);
  assert.equal(blocked.log.recorded.length, 2);
  assert.equal(blocked.log.failed.length, 0);
  assert.equal(blocked.deps.state.cooldownUntil, 2000);
});

function capture(rows = [], rowCount = 1) {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount }; };
  return { calls, restore: () => { pool.query = original; } };
}

test('pending selection: stale or missing translation, ready rows, retry-gated, oldest first', async () => {
  const c = capture([{ id: 'a' }]);
  try {
    await listPendingReviewTranslations(150);
    const { sql, params } = c.calls[0];
    assert.match(sql, /content_vi IS NULL OR r\.translated_hash IS DISTINCT FROM r\.content_hash/);
    assert.match(sql, /catalog_state='ready'/);
    assert.match(sql, /translate_retry_at IS NULL OR r\.translate_retry_at <= now\(\)/);
    assert.match(sql, /ORDER BY r\.created_at ASC/);
    assert.deepEqual(params, [150]);
  } finally { c.restore(); }
});

test('record translation: guarded by the source hash', async () => {
  const c = capture([], 0);
  try {
    assert.equal(await recordReviewTranslation('id', 'hash', 'vi'), false);
    assert.match(c.calls[0].sql, /WHERE id=\$1 AND content_hash=\$2/);
    assert.deepEqual(c.calls[0].params, ['id', 'hash', 'vi']);
  } finally { c.restore(); }
});

test('stale translation is hidden in SQL, and a content change clears the retry gate', async () => {
  const c = capture([]);
  try {
    await reviewsForMovie('m');
    assert.match(c.calls[0].sql, /CASE WHEN translated_hash = content_hash THEN content_vi END/);
  } finally { c.restore(); }
  const calls = [];
  const client = { async query(sql, params) { calls.push(sql); return { rows: [], rowCount: 0 }; }, release() {} };
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    await recordTmdbReviews('m', [{ tmdbReviewId: 'a', author: '', authorUsername: null, rating: null, content: 'new', createdAt: null, url: null, hasSpoiler: false, score: 1, contentHash: 'h2' }]);
  } finally { pool.connect = original; }
  assert.ok(calls.some((s) => /INSERT INTO movie_reviews/.test(s) && /translate_retry_at=CASE WHEN movie_reviews\.content_hash IS DISTINCT FROM/.test(s)));
  assert.ok(!calls.some((s) => /content_vi\s*=/.test(s)));
});

test('API shape: contentVi is string or null on the card and on /reviews pages, order untouched', async () => {
  assert.equal(reviewCard({ id: 'a', contentVi: 'xin chao' }).contentVi, 'xin chao');
  for (const value of [undefined, null, '']) assert.equal(reviewCard({ id: 'a', contentVi: value }).contentVi, null);
  const rows = [
    { id: 'a', author: 'x', rating: null, content: 'en', createdAt: null, url: null, hasSpoiler: false, score: 50, contentVi: 'vi' },
    { id: 'b', author: 'y', rating: null, content: 'en2', createdAt: null, url: null, hasSpoiler: false, score: 50, contentVi: null }
  ];
  const original = pool.query;
  pool.query = async (sql) => (/FROM movie_reviews/.test(sql) ? { rows } : { rows: [{ id: 'movie-id' }] });
  try {
    const page = await buildReviews('phim-a', 1, 10);
    assert.ok(page, 'page built');
    assert.equal(page.reviews.length, 2);
    assert.deepEqual(page.reviews.map((r) => r.contentVi).sort(), [null, 'vi']);
    assert.ok(page.reviews.every((r) => 'content' in r && 'contentVi' in r));
  } finally { pool.query = original; }
});
