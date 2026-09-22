import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTmdbCredits } from '../src/tmdb.js';

const BASE = 'https://tmdb.test/3';
const IMG_BASE = 'https://img.test/t/p';

function respond(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  });
}

test('fetchTmdbCredits: parses cast and directors, filters crew by job', async () => {
  const { cast, directors } = await fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, {
    apiKey: 'k',
    baseUrl: BASE,
    imageBaseUrl: IMG_BASE,
    fetchImpl: respond({
      cast: [
        { id: 1, name: 'Andy Lau', character: 'Officer Yan', order: 0, profile_path: '/andy.jpg' }
      ],
      crew: [
        { id: 2, name: 'Someone Producer', job: 'Producer' },
        { id: 3, name: 'Director Name', job: 'Director', profile_path: '/dir.jpg' }
      ]
    })
  });
  assert.deepEqual(cast, [{
    tmdbPersonId: 1,
    name: 'Andy Lau',
    profileSourceUrl: IMG_BASE + '/w500/andy.jpg',
    characterName: 'Officer Yan',
    order: 0
  }]);
  assert.deepEqual(directors, [{
    tmdbPersonId: 3,
    name: 'Director Name',
    profileSourceUrl: IMG_BASE + '/w500/dir.jpg',
    order: 0
  }]);
});

test('fetchTmdbCredits: castLimit trims cast but never crew directors', async () => {
  const { cast, directors } = await fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, {
    apiKey: 'k',
    baseUrl: BASE,
    castLimit: 2,
    fetchImpl: respond({
      cast: [
        { id: 1, name: 'A', order: 0 },
        { id: 2, name: 'B', order: 1 },
        { id: 3, name: 'C', order: 2 }
      ],
      crew: [
        { id: 10, name: 'D1', job: 'Director' },
        { id: 11, name: 'D2', job: 'Director' },
        { id: 12, name: 'D3', job: 'Director' }
      ]
    })
  });
  assert.deepEqual(cast.map((entry) => entry.tmdbPersonId), [1, 2]);
  assert.deepEqual(directors.map((entry) => entry.tmdbPersonId), [10, 11, 12]);
});

test('fetchTmdbCredits: a duplicate cast id is kept once', async () => {
  const { cast } = await fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, {
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: respond({
      cast: [
        { id: 1, name: 'Andy Lau', character: 'Role A', order: 0 },
        { id: 1, name: 'Andy Lau', character: 'Role B', order: 1 }
      ],
      crew: []
    })
  });
  assert.equal(cast.length, 1);
  assert.equal(cast[0].characterName, 'Role A');
});

test('fetchTmdbCredits: a null profile_path is kept as a null url, not dropped', async () => {
  const { cast } = await fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, {
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: respond({
      cast: [{ id: 1, name: 'Andy Lau', profile_path: null, order: 0 }],
      crew: []
    })
  });
  assert.equal(cast.length, 1);
  assert.equal(cast[0].profileSourceUrl, null);
});

test('fetchTmdbCredits: entries missing an id or an empty name are dropped', async () => {
  const { cast, directors } = await fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, {
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: respond({
      cast: [{ id: null, name: 'No Id' }, { id: 5, name: '   ' }],
      crew: [{ id: null, name: 'No Id', job: 'Director' }, { id: 6, name: '', job: 'Director' }]
    })
  });
  assert.deepEqual(cast, []);
  assert.deepEqual(directors, []);
});

test('fetchTmdbCredits: an empty body yields empty cast and directors', async () => {
  const result = await fetchTmdbCredits({ mediaType: 'tv', tmdbId: 42 }, {
    apiKey: 'k',
    baseUrl: BASE,
    fetchImpl: respond({})
  });
  assert.deepEqual(result, { cast: [], directors: [] });
});

test('fetchTmdbCredits: a 404 rejects with error.status === 404', async () => {
  await assert.rejects(
    () => fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, {
      apiKey: 'k',
      baseUrl: BASE,
      fetchImpl: respond({ status_code: 34 }, 404)
    }),
    (error) => error.status === 404
  );
});

test('fetchTmdbCredits: an identity missing mediaType rejects without a request', async () => {
  await assert.rejects(
    () => fetchTmdbCredits({ tmdbId: 7 }, {
      apiKey: 'k',
      baseUrl: BASE,
      fetchImpl: async () => {
        throw new Error('should not be called');
      }
    }),
    /TMDB identity is incomplete/
  );
});

test('fetchTmdbCredits: URLs hit /credits directly, no /season/ segment', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    return respond({})(url, init);
  };
  await fetchTmdbCredits({ mediaType: 'movie', tmdbId: 7 }, { apiKey: 'k', baseUrl: BASE, fetchImpl });
  await fetchTmdbCredits({ mediaType: 'tv', tmdbId: 42 }, { apiKey: 'k', baseUrl: BASE, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/3/movie/7/credits');
  assert.equal(calls[1].pathname, '/3/tv/42/credits');
  for (const url of calls) {
    assert.doesNotMatch(url.pathname, /\/season\//);
  }
});
