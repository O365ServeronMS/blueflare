import assert from 'node:assert/strict';
import test from 'node:test';
import { OmdbQuotaError, fetchOmdbByImdbId, parseOmdbScores } from '../src/omdb.js';
import { collectRatingSlugs, formatOmdbStats, syncOmdbRatings } from '../src/ratingsSync.js';

const KEY = 'test-key';
const BASE = 'https://www.omdbapi.com';

function omdbBody(overrides = {}) {
  return {
    Response: 'True',
    imdbID: 'tt0000001',
    imdbRating: '7.6',
    Metascore: '67',
    Ratings: [
      { Source: 'Internet Movie Database', Value: '7.6/10' },
      { Source: 'Rotten Tomatoes', Value: '85%' },
      { Source: 'Metacritic', Value: '67/100' }
    ],
    ...overrides
  };
}

function respond(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
}

test('reads the three scores out of the Ratings array', () => {
  assert.deepEqual(parseOmdbScores(omdbBody()), {
    tomatometer: 85,
    metascore: 67,
    imdbRating: 7.6
  });
});

test('every score is independently optional', () => {
  // The common shape on this catalog: OMDb knows the title but no critic has
  // scored it, so only the IMDb rating comes back.
  const scores = parseOmdbScores(omdbBody({
    Ratings: [{ Source: 'Internet Movie Database', Value: '8.3/10' }],
    imdbRating: '8.3'
  }));
  assert.deepEqual(scores, { tomatometer: null, metascore: null, imdbRating: 8.3 });
});

test('OMDb\'s "N/A" placeholder never becomes a score', () => {
  const scores = parseOmdbScores({
    imdbRating: 'N/A',
    Ratings: [
      { Source: 'Rotten Tomatoes', Value: 'N/A' },
      { Source: 'Metacritic', Value: 'N/A' }
    ]
  });
  assert.deepEqual(scores, { tomatometer: null, metascore: null, imdbRating: null });
});

test('malformed and out-of-range values are rejected rather than coerced', () => {
  const scores = parseOmdbScores({
    imdbRating: '12.5',
    Ratings: [
      { Source: 'Rotten Tomatoes', Value: '850%' },
      { Source: 'Metacritic', Value: '67' }
    ]
  });
  assert.deepEqual(scores, { tomatometer: null, metascore: null, imdbRating: null });
});

test('a title OMDb has no entry for is unmatched, not an error', async () => {
  const result = await fetchOmdbByImdbId('tt0000001', {
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl: respond({ Response: 'False', Error: 'Incorrect IMDb ID.' })
  });
  assert.equal(result.status, 'unmatched');
});

test('a response for a different title is refused', async () => {
  // Cheap insurance: a mismatched id means the score would be attached to the
  // wrong film, which is invisible once rendered.
  const result = await fetchOmdbByImdbId('tt0000001', {
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl: respond(omdbBody({ imdbID: 'tt9999999' }))
  });
  assert.equal(result.status, 'unmatched');
  assert.equal(result.detail, 'imdb id mismatch');
});

test('a spent daily quota throws so the batch can stop instead of 401-ing on', async () => {
  await assert.rejects(
    () => fetchOmdbByImdbId('tt0000001', {
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: respond({ Response: 'False', Error: 'Request limit reached!' }, 401)
    }),
    (error) => error instanceof OmdbQuotaError && error.code === 'OMDB_QUOTA'
  );
});

test('an id that is not an IMDb id spends no request at all', async () => {
  let called = 0;
  const result = await fetchOmdbByImdbId('not-an-id', {
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl: async () => { called += 1; }
  });
  assert.equal(result.status, 'unmatched');
  assert.equal(called, 0);
});

test('a non-HTTPS base URL is refused', async () => {
  await assert.rejects(
    () => fetchOmdbByImdbId('tt0000001', { apiKey: KEY, baseUrl: 'http://www.omdbapi.com' }),
    /must use HTTPS/
  );
});

test('slugs are collected hero-first, de-duplicated, and filtered by bucket', () => {
  const slugs = collectRatingSlugs([
    {
      bucket: 'trending',
      payload: {
        heroMovies: [{ slug: 'hero-a' }, { slug: 'hero-b' }],
        // Present in the home payload but not part of the trending bucket:
        // reading it would silently defeat OMDB_RATING_TYPES.
        phimBo: { items: [{ slug: 'series-a' }] }
      }
    },
    { bucket: 'phim-le', payload: { data: { items: [{ slug: 'hero-a' }, { slug: 'film-a' }] } } }
  ]);
  assert.deepEqual(slugs, ['hero-a', 'hero-b', 'film-a']);
});

function harness(overrides = {}) {
  const calls = { omdb: [], scores: [], misses: [], reserved: [], released: [] };
  const deps = {
    enabled: true,
    tmdbEnabled: true,
    concurrency: 1,
    listCandidates: async (slugs) => slugs.map((slug, index) => ({
      id: 'id-' + index,
      canonical_slug: slug,
      media_type: 'movie',
      imdb_id: 'tt000000' + (index + 1),
      tmdb_id: null,
      tmdb_media_type: null
    })),
    reserveBudget: async (requested) => {
      calls.reserved.push(requested);
      return { granted: requested, used: requested, ceiling: 950 };
    },
    releaseBudget: async (count) => { calls.released.push(count); },
    recordScores: async (id, scores) => { calls.scores.push([id, scores]); },
    recordMiss: async (id, status) => { calls.misses.push([id, status]); },
    fetchOmdb: async (imdbId) => {
      calls.omdb.push(imdbId);
      return { status: 'matched', imdbId, tomatometer: 85, metascore: 67, imdbRating: 7.6 };
    },
    resolveExternalId: async () => null,
    ...overrides
  };
  return { deps, calls };
}

const SOURCES = [{ bucket: 'trending', payload: { heroMovies: [{ slug: 'a' }, { slug: 'b' }] } }];

test('scores the visible rows and reports them as changed', async () => {
  const { deps, calls } = harness();
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.visible, 2);
  assert.equal(stats.matched, 2);
  assert.equal(stats.tomato, 2);
  assert.equal(stats.spent, 2);
  assert.deepEqual(stats.changedSlugs, ['a', 'b']);
  assert.deepEqual(calls.released, [0]);
});

test('a match carrying no usable score is not pushed through invalidation', async () => {
  // Invalidation drops the whole home/list keyspace, so it must not fire for a
  // row whose rendered output is identical to what is already cached.
  const { deps } = harness({
    fetchOmdb: async (imdbId) => ({
      status: 'matched', imdbId, tomatometer: null, metascore: 40, imdbRating: null
    })
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.matched, 2);
  assert.deepEqual(stats.changedSlugs, []);
});

test('the run is capped by whatever the budget grants, in visible order', async () => {
  const { deps, calls } = harness({
    reserveBudget: async () => ({ granted: 1, used: 950, ceiling: 950 })
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.selected, 2);
  assert.equal(stats.reserved, 1);
  assert.deepEqual(calls.omdb, ['tt0000001']);
  assert.deepEqual(stats.changedSlugs, ['a']);
});

test('an exhausted budget declines before issuing any request', async () => {
  const { deps, calls } = harness({
    reserveBudget: async () => ({ granted: 0, used: 950, ceiling: 950 })
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.declined, 'budget-exhausted');
  assert.deepEqual(calls.omdb, []);
});

test('hitting the quota mid-batch stops the rest and drains the day', async () => {
  const { deps, calls } = harness({
    concurrency: 1,
    fetchOmdb: async () => { throw new OmdbQuotaError('Request limit reached!'); }
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.match(stats.declined, /^quota:/);
  // One attempt, then the second row is skipped rather than 401-ing too.
  assert.equal(calls.omdb.length, 0);
  // Nothing is refunded and the remaining allowance is claimed, so the next
  // cycle does not walk straight back into another 401.
  assert.deepEqual(calls.reserved, [2, 950]);
  assert.deepEqual(calls.released, []);
});

test('unspent claims are handed back so a short batch does not waste the day', async () => {
  const { deps, calls } = harness({
    listCandidates: async () => ([
      { id: 'id-0', canonical_slug: 'a', media_type: 'movie', imdb_id: null, tmdb_id: null }
    ])
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.noId, 1);
  assert.equal(stats.spent, 0);
  assert.deepEqual(calls.released, [1]);
  assert.deepEqual(calls.misses, [['id-0', 'no-tmdb-id']]);
});

test('a missing imdb_id is resolved through TMDB without spending OMDb quota', async () => {
  const { deps, calls } = harness({
    listCandidates: async () => ([
      { id: 'id-0', canonical_slug: 'a', media_type: 'tv', imdb_id: null, tmdb_id: 4242, tmdb_media_type: 'tv' }
    ]),
    resolveExternalId: async (identity) => {
      assert.deepEqual(identity, { tmdbId: 4242, mediaType: 'tv' });
      return 'tt7654321';
    }
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.lifted, 1);
  assert.deepEqual(calls.omdb, ['tt7654321']);
});

test('a row TMDB cannot resolve is marked unreachable so it is never retried', async () => {
  const { deps, calls } = harness({
    listCandidates: async () => ([
      { id: 'id-0', canonical_slug: 'a', media_type: 'movie', imdb_id: null, tmdb_id: 4242, tmdb_media_type: 'movie' }
    ])
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.noId, 1);
  assert.deepEqual(calls.misses, [['id-0', 'no-imdb-id']]);
});

test('a transport failure is recorded per row without failing the pass', async () => {
  const { deps, calls } = harness({
    fetchOmdb: async () => { throw new Error('socket hang up'); }
  });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.errors['socket hang up'], 2);
  assert.deepEqual(stats.changedSlugs, []);
  assert.deepEqual(calls.misses, [['id-0', 'error'], ['id-1', 'error']]);
});

test('the pass stands down when OMDb is not configured', async () => {
  const { deps, calls } = harness({ enabled: false });
  const stats = await syncOmdbRatings(SOURCES, deps);
  assert.equal(stats.declined, 'disabled');
  assert.deepEqual(calls.reserved, []);
});

test('stats format as one greppable line', () => {
  const line = formatOmdbStats({
    visible: 40, selected: 12, reserved: 12, spent: 12, matched: 9, tomato: 3,
    unmatched: 3, lifted: 1, noId: 0, errors: { timeout: 2 }, declined: null, durationMs: 812
  });
  assert.match(line, /visible=40 selected=12 reserved=12 spent=12 matched=9 tomato=3/);
  assert.match(line, /errors=timeoutx2/);
});
