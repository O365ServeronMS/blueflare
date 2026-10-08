import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { hasSpoilerWarning } from '../src/reviewSpoiler.js';
import { orderReviews, reviewCard } from '../src/reviewOrder.js';
import { parseTmdbReviews, scoreReview, toPlainText } from '../src/tmdbReviews.js';
import { fetchTmdbReviews } from '../src/tmdb.js';
import { syncTmdbReviews } from '../src/tmdbReviewsSync.js';
import {
  recordTmdbReviews,
  recordTmdbReviewsFailure,
  listTmdbReviewCandidates
} from '../src/repository.js';
import { buildReviews } from '../src/viewmodels.js';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const LONG = 'A thoughtful film with strong performances and a patient, confident script. '.repeat(2);

test('spoiler: positive phrases', () => {
  for (const text of [
    'SPOILER ALERT: the ending is wild. ' + LONG,
    LONG + ' This review contains spoilers.',
    'Spoilers ahead! ' + LONG,
    LONG + ' [spoiler]',
    'Warning: major spoilers. ' + LONG
  ]) assert.equal(hasSpoilerWarning(text), true, text.slice(0, 40));
});

test('spoiler: negative phrases and mid-text mentions', () => {
  for (const text of [
    'Spoiler-free review. ' + LONG,
    'No spoilers here. ' + LONG,
    LONG + ' Reviewed without spoilers.',
    'I will not give away any spoilers. ' + LONG,
    'This review contains no spoilers. ' + LONG,
    LONG.repeat(6) + ' the trailer was a spoiler in itself ' + LONG.repeat(6),
    ''
  ]) assert.equal(hasSpoilerWarning(text), false, text.slice(0, 40));
});

test('plain text: html and markdown become inert text', () => {
  const out = toPlainText('**Great** <script>alert(1)</script><b>film</b> &lt;img src=x onerror=alert(1)&gt; [link](http://x.y) &amp; more<br>next');
  assert.doesNotMatch(out, /[<>]|script|onerror=.*>|\*\*|\]\(/);
  assert.match(out, /Great film/);
  assert.match(out, /& more\nnext/);
});

test('score: weights, neutral rating, length cap and recency decay', () => {
  const base = { rating: 10, content: 'x'.repeat(1500), createdAt: new Date(NOW).toISOString() };
  assert.equal(scoreReview(base, NOW), 100);
  const noRating = scoreReview({ ...base, rating: null }, NOW);
  assert.equal(noRating, 50 * 0.6 + 25 + 15);
  assert.equal(scoreReview({ ...base, content: 'x'.repeat(9000) }, NOW), 100);
  const old = scoreReview({ ...base, createdAt: new Date(NOW - 365 * 86400000).toISOString() }, NOW);
  assert.ok(old < 100 && old > 85);
  assert.ok(scoreReview({ ...base, rating: 3 }, NOW) < scoreReview({ ...base, rating: 9 }, NOW));
  assert.equal(scoreReview({ ...base, rating: 0, content: '', createdAt: null }, NOW), 0);
});

test('parse: drops short, dedupes, truncates, caps, rejects foreign urls', () => {
  const results = [
    { id: 'a', author: 'A', content: 'too short', created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', author: 'B', content: LONG + 'z'.repeat(5000), url: 'https://www.themoviedb.org/review/b', author_details: { rating: 8, username: 'bee' }, created_at: '2026-09-01T00:00:00Z' },
    { id: 'b', author: 'B', content: LONG },
    { id: 'c', author: 'C', content: LONG, url: 'javascript:alert(1)', author_details: { rating: null } },
    { id: 'd', author: 'D', content: LONG, author_details: { rating: 2 } }
  ];
  const parsed = parseTmdbReviews(results, { now: NOW, maxPerMovie: 2 });
  assert.equal(parsed.length, 2);
  const b = parsed.find((r) => r.tmdbReviewId === 'b');
  assert.equal(b.content.length <= 4000, true);
  assert.equal(b.rating, 8);
  assert.equal(b.authorUsername, 'bee');
  const all = parseTmdbReviews(results, { now: NOW, maxPerMovie: 10 });
  assert.deepEqual(all.map((r) => r.tmdbReviewId).sort(), ['b', 'c', 'd']);
  assert.equal(all.find((r) => r.tmdbReviewId === 'c').url, null);
});

function rev(id, score, hasSpoiler = false) {
  return { id, score, hasSpoiler, author: 'x', rating: null, content: 'c', createdAt: null, url: null };
}

test('order: spoiler first, bands descending, deterministic per day+slug', () => {
  const input = [rev('1', 91), rev('2', 93), rev('3', 95), rev('4', 55), rev('5', 12, true), rev('6', 99, false), rev('7', 20, true)];
  const a = orderReviews(input, 'phim-a', NOW).map((r) => r.id);
  const b = orderReviews([...input].reverse(), 'phim-a', NOW).map((r) => r.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a.slice(0, 2).sort(), ['5', '7']);
  assert.deepEqual(a.slice(2, 6).sort(), ['1', '2', '3', '6']);
  assert.equal(a[6], '4');
  // The shuffle moves with the day and with the slug.
  const orders = new Set();
  for (let d = 0; d < 10; d += 1) orders.add(orderReviews(input, 'phim-a', NOW + d * 86400000).map((r) => r.id).join());
  assert.ok(orders.size > 1);
  assert.equal(orderReviews(input, 'phim-a', NOW + 3600000).map((r) => r.id).join(), a.join());
});

test('reviewCard: exact public fields', () => {
  assert.deepEqual(Object.keys(reviewCard({ id: 'i', author: 'a', rating: '7.5', content: 'c', createdAt: 't', url: 'u', hasSpoiler: 1, score: 9, author_username: 'x' })),
    ['id', 'author', 'rating', 'content', 'createdAt', 'url', 'hasSpoiler', 'contentVi']);
  assert.equal(reviewCard({ rating: '7.5' }).rating, 7.5);
});

test('fetchTmdbReviews: at most two pages, stops at total_pages, 404 propagates', async () => {
  const urls = [];
  const fetchImpl = (total) => async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results: [{ id: String(urls.length) }], total_pages: total }) };
  };
  const opts = { apiKey: 'k', baseUrl: 'https://tmdb.test/3' };
  const five = await fetchTmdbReviews({ mediaType: 'tv', tmdbId: 5 }, { ...opts, fetchImpl: fetchImpl(9) });
  assert.equal(five.length, 2);
  assert.match(urls[0], /\/tv\/5\/reviews\?page=1.*language=en-US/);
  urls.length = 0;
  assert.equal((await fetchTmdbReviews({ mediaType: 'movie', tmdbId: 5 }, { ...opts, fetchImpl: fetchImpl(1) })).length, 1);
  await assert.rejects(
    fetchTmdbReviews({ mediaType: 'movie', tmdbId: 5 }, { ...opts, fetchImpl: async () => ({ ok: false, status: 404 }) }),
    (error) => error.status === 404
  );
});

function fakeClient(existingRows, removedCount = 0) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^SELECT tmdb_review_id/.test(sql)) return { rows: existingRows };
      if (/^DELETE/.test(sql)) return { rowCount: removedCount, rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
}

async function withClient(client, fn) {
  const original = pool.connect;
  pool.connect = async () => client;
  try { return await fn(); } finally { pool.connect = original; }
}

const parsedOne = () => parseTmdbReviews([{ id: 'r1', author: 'A', content: LONG, created_at: '2026-09-01T00:00:00Z' }], { now: NOW });

test('recordTmdbReviews: upserts, deletes the gone ones, stamps marks in one transaction', async () => {
  const reviews = parsedOne();
  const client = fakeClient([{ tmdb_review_id: 'old', content_hash: 'h' }], 1);
  const result = await withClient(client, () => recordTmdbReviews('m1', reviews, { refreshMs: 1000 }));
  assert.deepEqual(result, { changed: true, count: 1 });
  const sqls = client.calls.map((c) => c.sql.split(' ')[0]);
  assert.deepEqual(sqls.filter((s) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s)), ['BEGIN', 'COMMIT']);
  const del = client.calls.find((c) => /^DELETE/.test(c.sql));
  assert.deepEqual(del.params, ['m1', ['r1']]);
  assert.match(client.calls.find((c) => /ON CONFLICT \(movie_id, tmdb_review_id\)/.test(c.sql)).sql, /DO UPDATE/);
  const stamp = client.calls.find((c) => /reviews_checked_at=now\(\)/.test(c.sql));
  assert.deepEqual(stamp.params, ['m1', 1000]);
});

test('recordTmdbReviews: identical content is not a change; empty still stamps', async () => {
  const [review] = parsedOne();
  const same = fakeClient([{ tmdb_review_id: 'r1', content_hash: review.contentHash }]);
  assert.equal((await withClient(same, () => recordTmdbReviews('m1', [review]))).changed, false);
  const empty = fakeClient([]);
  const result = await withClient(empty, () => recordTmdbReviews('m1', []));
  assert.deepEqual(result, { changed: false, count: 0 });
  assert.ok(empty.calls.some((c) => /reviews_checked_at=now\(\)/.test(c.sql)));
});

test('recordTmdbReviews: rolls back and releases on failure', async () => {
  const client = fakeClient([]);
  const original = client.query;
  client.query = async (sql, params) => {
    if (/^INSERT INTO movie_reviews/.test(sql)) throw new Error('boom');
    return original.call(client, sql, params);
  };
  await assert.rejects(withClient(client, () => recordTmdbReviews('m1', parsedOne())), /boom/);
  assert.ok(client.calls.some((c) => c.sql === 'ROLLBACK'));
  assert.equal(client.calls.at(-1).sql, 'RELEASE');
});

function capture(rows = []) {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows }; };
  return { calls, restore: () => { pool.query = original; } };
}

test('recordTmdbReviewsFailure: only moves the retry gate', async () => {
  const c = capture();
  try {
    await recordTmdbReviewsFailure('m1', { retryMs: 5000 });
    assert.match(c.calls[0].sql, /reviews_next_retry_at=/);
    assert.doesNotMatch(c.calls[0].sql, /reviews_checked_at/);
    assert.deepEqual(c.calls[0].params, ['m1', 5000]);
  } finally { c.restore(); }
});

test('listTmdbReviewCandidates: verified identity only, retry-gated, oldest first', async () => {
  const c = capture([{ id: 'a' }]);
  try {
    await listTmdbReviewCandidates(7);
    const { sql, params } = c.calls[0];
    assert.match(sql, /tmdb_match_status='verified'/);
    assert.match(sql, /reviews_next_retry_at IS NULL OR c\.reviews_next_retry_at <= now\(\)/);
    assert.match(sql, /reviews_checked_at ASC NULLS FIRST/);
    assert.deepEqual(params, [7]);
  } finally { c.restore(); }
});

const syncConfig = {
  tmdbEnabled: true, tmdbReviewsEnabled: true, tmdbApiKey: 'k', tmdbReviewsLimit: 10,
  tmdbReviewsConcurrency: 2, tmdbReviewsMaxPerMovie: 40, tmdbReviewsRefreshMs: 111, tmdbReviewsRetryMs: 222
};

test('syncTmdbReviews: 404 and empty stamp checked, other errors only back off, changed slugs returned', async () => {
  const candidates = [
    { id: 'ok', canonical_slug: 'ok', media_type: 'movie', tmdb_id: '1' },
    { id: 'nf', canonical_slug: 'nf', media_type: 'movie', tmdb_id: '2' },
    { id: 'em', canonical_slug: 'em', media_type: 'tv', tmdb_id: '3' },
    { id: 'er', canonical_slug: 'er', media_type: 'tv', tmdb_id: '4' }
  ];
  const recorded = [];
  const failed = [];
  const changed = await syncTmdbReviews({
    config: syncConfig,
    now: NOW,
    listCandidates: async () => candidates,
    fetchReviews: async ({ tmdbId }) => {
      if (tmdbId === 1) return [{ id: 'r', content: LONG, author: 'a' }];
      if (tmdbId === 2) throw Object.assign(new Error('nf'), { status: 404 });
      if (tmdbId === 3) return [{ id: 'short', content: 'meh' }];
      throw Object.assign(new Error('down'), { status: 500 });
    },
    record: async (id, reviews, options) => {
      recorded.push({ id, n: reviews.length, refreshMs: options.refreshMs });
      return { changed: reviews.length > 0 };
    },
    recordFailure: async (id, options) => { failed.push({ id, retryMs: options.retryMs }); }
  });
  assert.deepEqual(changed, ['ok']);
  assert.deepEqual(recorded.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'em', n: 0, refreshMs: 111 }, { id: 'nf', n: 0, refreshMs: 111 }, { id: 'ok', n: 1, refreshMs: 111 }
  ]);
  assert.deepEqual(failed, [{ id: 'er', retryMs: 222 }]);
});

test('syncTmdbReviews: disabled flags skip without touching TMDB', async () => {
  const list = async () => { throw new Error('must not run'); };
  assert.deepEqual(await syncTmdbReviews({ config: { ...syncConfig, tmdbReviewsEnabled: false }, listCandidates: list }), []);
  assert.deepEqual(await syncTmdbReviews({ config: { ...syncConfig, tmdbEnabled: false }, listCandidates: list }), []);
});

test('buildReviews: API shape, paging, empty array, unknown movie', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: 'id' + i, author: 'a' + i, rating: '8.0', content: 'c', createdAt: '2026-09-01T00:00:00.000Z',
    url: 'https://www.themoviedb.org/review/' + i, hasSpoiler: i === 0, score: '70'
  }));
  const original = pool.query;
  let stored = rows;
  pool.query = async (sql) => {
    if (/FROM movies m WHERE/.test(sql)) return { rows: [{ id: 'mid' }] };
    if (/FROM movie_slug_aliases/.test(sql)) return { rows: [] };
    if (/FROM movie_provider_sources WHERE/.test(sql)) return { rows: [] };
    if (/FROM movie_reviews/.test(sql)) return { rows: stored };
    return { rows: [] };
  };
  try {
    const first = await buildReviews('phim-x', 1, 5);
    assert.deepEqual(Object.keys(first), ['reviews', 'reviewCount', 'page', 'limit', 'totalPages']);
    assert.deepEqual(Object.keys(first.reviews[0]), ['id', 'author', 'rating', 'content', 'createdAt', 'url', 'hasSpoiler', 'contentVi']);
    assert.equal(first.reviews.length, 5);
    assert.equal(first.reviews[0].hasSpoiler, true);
    assert.equal(first.reviews[0].rating, 8);
    assert.equal(first.reviewCount, 12);
    assert.equal(first.totalPages, 3);
    const third = await buildReviews('phim-x', 3, 5);
    assert.equal(third.reviews.length, 2);
    const ids = [...(await buildReviews('phim-x', 1, 5)).reviews, ...(await buildReviews('phim-x', 2, 5)).reviews, ...third.reviews].map((r) => r.id);
    assert.equal(new Set(ids).size, 12);
    stored = [];
    const empty = await buildReviews('phim-x', 1, 5);
    assert.deepEqual(empty.reviews, []);
    assert.equal(empty.totalPages, 1);
    pool.query = async () => ({ rows: [] });
    assert.equal(await buildReviews('nope', 1, 5), null);
  } finally { pool.query = original; }
});

test('reviews cache key normalizes and bounds the slug', async () => {
  const { reviewsCacheKey } = await import('../src/reviewOrder.js');
  assert.equal(reviewsCacheKey('  Phim-A ', 2, 5), 'reviews:phim-a:2:5');
  assert.equal(reviewsCacheKey('X'.repeat(500), 1, 5), 'reviews:' + 'x'.repeat(160) + ':1:5');
});

test('reviews invalidation covers pages 1..4 for limits 2 and 10', async () => {
  const { reviewsInvalidationKeys } = await import('../src/reviewOrder.js');
  const keys = reviewsInvalidationKeys('phim-a');
  assert.equal(keys.length, 8);
  for (const limit of [2, 10]) for (let p = 1; p <= 4; p += 1) assert.ok(keys.includes('reviews:phim-a:' + p + ':' + limit));
});
