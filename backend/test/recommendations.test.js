import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combineRecommendationRows,
  mergeRecommendationIds,
  recommendationSource
} from '../src/recommendations.js';
import { fetchTmdbRecommendations } from '../src/tmdb.js';

const BASE = 'https://tmdb.test/3';

function respond(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  });
}

test('recommendationSource: tmdb_id wins even alongside a tmdb_lookup_id', () => {
  const source = recommendationSource({
    tmdb_id: 42,
    tmdb_media_type: 'tv',
    tmdb_lookup_id: 99,
    media_type: 'movie'
  });
  assert.deepEqual(source, { mediaType: 'tv', tmdbId: 42 });
});

test('recommendationSource: falls back to tmdb_lookup_id with media_type', () => {
  const source = recommendationSource({
    tmdb_id: null,
    tmdb_lookup_id: 7,
    media_type: 'movie'
  });
  assert.deepEqual(source, { mediaType: 'movie', tmdbId: 7 });
});

test('recommendationSource: falls back to tmdb_image_fallback_id alone', () => {
  const source = recommendationSource({
    tmdb_id: null,
    tmdb_lookup_id: null,
    tmdb_image_fallback_id: 13,
    media_type: 'tv'
  });
  assert.deepEqual(source, { mediaType: 'tv', tmdbId: 13 });
});

test('recommendationSource: a stringified bigint id is coerced to a number', () => {
  const source = recommendationSource({
    tmdb_id: null,
    tmdb_lookup_id: '123',
    media_type: 'movie'
  });
  assert.deepEqual(source, { mediaType: 'movie', tmdbId: 123 });
});

test('recommendationSource: an unsupported media_type without tmdb_id is null', () => {
  const source = recommendationSource({
    tmdb_id: null,
    tmdb_lookup_id: 7,
    media_type: 'hoathinh'
  });
  assert.equal(source, null);
});

test('recommendationSource: no usable id at all is null', () => {
  assert.equal(recommendationSource({ media_type: 'movie' }), null);
});

test('mergeRecommendationIds: recommended precedes similar', () => {
  const ids = mergeRecommendationIds([1, 2], [3, 4], null);
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test('mergeRecommendationIds: duplicates across both lists collapse', () => {
  const ids = mergeRecommendationIds([1, 2], [2, 3], null);
  assert.deepEqual(ids, [1, 2, 3]);
});

test('mergeRecommendationIds: the source id itself is excluded', () => {
  const ids = mergeRecommendationIds([1, 2], [2, 3], 2);
  assert.deepEqual(ids, [1, 3]);
});

test('mergeRecommendationIds: zero, negative, and non-numeric ids are dropped', () => {
  const ids = mergeRecommendationIds([0, -1, 'abc', 5], [], null);
  assert.deepEqual(ids, [5]);
});

test('combineRecommendationRows: ranked rows precede fill rows', () => {
  const ranked = [{ id: 'a' }];
  const fill = [{ id: 'b' }, { id: 'c' }, { id: 'd' }];
  const rows = combineRecommendationRows(ranked, fill, { minimum: 1 });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c', 'd']);
});

test('combineRecommendationRows: a duplicate id across lists is kept once', () => {
  const ranked = [{ id: 'a' }];
  const fill = [{ id: 'a' }, { id: 'b' }];
  const rows = combineRecommendationRows(ranked, fill, { minimum: 1 });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
});

test('combineRecommendationRows: cuts off at the limit', () => {
  const ranked = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const rows = combineRecommendationRows(ranked, [], { limit: 2, minimum: 1 });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
});

test('combineRecommendationRows: fewer than the minimum returns nothing', () => {
  const ranked = [{ id: 'a' }, { id: 'b' }];
  const rows = combineRecommendationRows(ranked, [], { minimum: 4 });
  assert.deepEqual(rows, []);
});

test('fetchTmdbRecommendations: calls recommendations then similar for the identity', async () => {
  const calls = [];
  await fetchTmdbRecommendations({ mediaType: 'tv', tmdbId: 42 }, {
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: async (url, init) => {
      calls.push(url);
      return respond({ results: [] })(url, init);
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/3/tv/42/recommendations');
  assert.equal(calls[0].searchParams.get('page'), '1');
  assert.equal(calls[1].pathname, '/3/tv/42/similar');
  assert.equal(calls[1].searchParams.get('page'), '1');
});

test('fetchTmdbRecommendations: dedupes and drops invalid ids from both lists', async () => {
  const { recommended, similar } = await fetchTmdbRecommendations({ mediaType: 'movie', tmdbId: 7 }, {
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith('/recommendations')) {
        return respond({ results: [{ id: 1 }, { id: 1 }, { id: 0 }, { id: 'abc' }, { id: 2 }] })();
      }
      return respond({ results: [{ id: 3 }, { id: 3 }] })();
    }
  });
  assert.deepEqual(recommended, [1, 2]);
  assert.deepEqual(similar, [3]);
});

test('fetchTmdbRecommendations: a 404 rejects with error.status === 404', async () => {
  await assert.rejects(
    () => fetchTmdbRecommendations({ mediaType: 'movie', tmdbId: 7 }, {
      apiKey: 'k',
      baseUrl: BASE,
      fetchImpl: respond({ status_code: 34 }, 404)
    }),
    (error) => error.status === 404
  );
});

test('fetchTmdbRecommendations: an unsupported media type rejects without a request', async () => {
  await assert.rejects(
    () => fetchTmdbRecommendations({ mediaType: 'hoathinh', tmdbId: 7 }, {
      apiKey: 'k',
      baseUrl: BASE,
      fetchImpl: async () => {
        throw new Error('should not be called');
      }
    }),
    /TMDB identity is incomplete/
  );
});
