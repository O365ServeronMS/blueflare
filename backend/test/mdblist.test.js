import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MdblistQuotaError,
  fetchMdblistRatings,
  mdblistKeyId,
  parseMdblistRatings
} from '../src/mdblist.js';
import { mdblistEffectiveHeadroom, reserveMdblistBudget } from '../src/repository.js';
import { pool } from '../src/db.js';
import { backfillMdblistRatings, formatMdblistStats, syncMdblistRatings } from '../src/mdblistRatingsSync.js';

const BASE = 'https://api.mdblist.com';
const SOURCES = [{
  bucket: 'trending',
  payload: { heroMovies: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] }
}];

function body(ratingSource = 'tomatoes', overrides = {}) {
  return {
    provider_id: 'tmdb',
    provider_rating: ratingSource,
    mediatype: 'movie',
    ratings: [{ id: 101, rating: 0 }, { id: 102, rating: 94 }],
    ...overrides
  };
}

function respond(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  });
}

test('parses requested MDBList percentages including zero', () => {
  assert.deepEqual(parseMdblistRatings(body(), {
    provider: 'tmdb', mediaType: 'movie', ratingSource: 'tomatoes', ids: ['101', '102']
  }), [
    { id: '101', rating: 0 },
    { id: '102', rating: 94 }
  ]);
});

test('ignores malformed, duplicate, out-of-range, and unrequested ratings', () => {
  const ratings = parseMdblistRatings(body('audience', {
    provider_rating: 'audience',
    ratings: [
      { id: 101, rating: 45 },
      { id: 101, rating: 46 },
      { id: 102, rating: 900 },
      { id: 102, rating: null },
      { id: 999, rating: 80 }
    ]
  }), {
    provider: 'tmdb', mediaType: 'movie', ratingSource: 'audience', ids: ['101', '102']
  });
  assert.deepEqual(ratings, [{ id: '101', rating: 45 }]);
});

test('refuses a response for the wrong source or media type', () => {
  assert.throws(() => parseMdblistRatings(body(), {
    provider: 'tmdb', mediaType: 'show', ratingSource: 'tomatoes', ids: ['101']
  }), /identity mismatch/);
});

test('issues the documented batch POST without leaking the key into the body', async () => {
  let request;
  const result = await fetchMdblistRatings({
    provider: 'tmdb', mediaType: 'movie', ratingSource: 'audience', ids: ['101', '102']
  }, {
    apiKey: 'test-key',
    baseUrl: BASE,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return respond(body('audience', { provider_rating: 'audience' }))();
    }
  });
  assert.equal(request.url.pathname, '/rating/movie/audience');
  assert.equal(request.url.searchParams.get('apikey'), 'test-key');
  assert.deepEqual(JSON.parse(request.init.body), { provider: 'tmdb', ids: ['101', '102'] });
  assert.ok(!request.init.body.includes('test-key'));
  assert.equal(result.ratings.length, 2);
});

test('turns HTTP 429 into a quota signal for key rollover', async () => {
  await assert.rejects(
    () => fetchMdblistRatings({
      provider: 'tmdb', mediaType: 'movie', ratingSource: 'tomatoes', ids: ['101']
    }, { apiKey: 'test-key', baseUrl: BASE, fetchImpl: respond({ detail: 'limit' }, 429) }),
    (error) => error instanceof MdblistQuotaError && error.code === 'MDBLIST_QUOTA'
  );
});

test('requires HTTPS before sending a request', async () => {
  await assert.rejects(
    () => fetchMdblistRatings({
      provider: 'tmdb', mediaType: 'movie', ratingSource: 'tomatoes', ids: ['101']
    }, { apiKey: 'test-key', baseUrl: 'http://api.mdblist.com' }),
    /must use HTTPS/
  );
});

function harness(overrides = {}) {
  const calls = { fetches: [], results: [], misses: [], budgets: [] };
  const candidates = [
    {
      id: 'row-a', canonical_slug: 'a', media_type: 'movie', tmdb_id: 101,
      tmdb_media_type: 'movie', imdb_id: null, mdblist_tomatoes: null, mdblist_audience: null
    },
    {
      id: 'row-b', canonical_slug: 'b', media_type: 'movie', tmdb_id: 102,
      tmdb_media_type: 'movie', imdb_id: null, mdblist_tomatoes: 10, mdblist_audience: null
    },
    {
      id: 'row-c', canonical_slug: 'c', media_type: 'tv', tmdb_id: 201,
      tmdb_media_type: 'tv', imdb_id: null, mdblist_tomatoes: null, mdblist_audience: null
    }
  ];
  const deps = {
    enabled: true,
    apiKeys: ['key-1'],
    concurrency: 1,
    idsPerRequest: 10,
    batchLimit: 60,
    listCandidates: async () => candidates,
    listBackfill: async () => [],
    reserveBudget: async (keyId, requested) => {
      calls.budgets.push([keyId, requested]);
      return { granted: requested, used: requested, ceiling: 950 };
    },
    recordResult: async (id, result) => { calls.results.push([id, result]); },
    recordMiss: async (id, status) => { calls.misses.push([id, status]); },
    fetchRatings: async (request, { apiKey } = {}) => {
      calls.fetches.push([apiKey, request]);
      const ratings = request.mediaType === 'show'
        ? []
        : request.ids.map((id) => ({ id, rating: request.ratingSource === 'tomatoes' ? Number(id) - 101 : 80 }));
      return { ...request, ratings };
    },
    ...overrides
  };
  return { deps, calls, candidates };
}

test('batches movie/show requests and records the two sources independently', async () => {
  const { deps, calls } = harness();
  const stats = await syncMdblistRatings(SOURCES, deps);
  assert.equal(stats.spent, 4);
  assert.equal(stats.matched, 2);
  assert.equal(stats.unmatched, 1);
  assert.equal(stats.tomatoes, 2);
  assert.equal(stats.audience, 2);
  assert.deepEqual(stats.changedSlugs, ['a', 'b']);
  assert.equal(calls.results[0][1].tomatoes, 0);
  assert.equal(calls.results[0][1].audience, 80);
  assert.equal(calls.results[2][1].status, 'unmatched');
});

test('splits ids at the configured free-account batch size', async () => {
  const { deps, calls } = harness({ idsPerRequest: 1 });
  const stats = await syncMdblistRatings(SOURCES, deps);
  assert.equal(stats.spent, 6);
  assert.ok(calls.fetches.every(([, request]) => request.ids.length === 1));
});

test('a quota response drains one key and retries the same request on the next', async () => {
  const { deps, calls } = harness({
    apiKeys: ['key-1', 'key-2'],
    listCandidates: async () => ([
      {
        id: 'row-a', canonical_slug: 'a', media_type: 'movie', tmdb_id: 101,
        tmdb_media_type: 'movie', mdblist_tomatoes: null, mdblist_audience: null
      }
    ]),
    fetchRatings: async (request, { apiKey } = {}) => {
      calls.fetches.push([apiKey, request]);
      if (apiKey === 'key-1') throw new MdblistQuotaError('limit');
      return { ...request, ratings: [{ id: '101', rating: 75 }] };
    }
  });
  const stats = await syncMdblistRatings(SOURCES, deps);
  assert.equal(stats.matched, 1);
  assert.equal(stats.keysDrained, 1);
  assert.equal(stats.keysTried, 2);
  assert.deepEqual(calls.fetches.map(([key]) => key), ['key-1', 'key-2', 'key-2']);
  assert.ok(calls.budgets.some(([keyId, requested]) => keyId === mdblistKeyId('key-1') && requested === 950));
});

test('one failed source records a partial result without clearing that source', async () => {
  const { deps, calls } = harness({
    listCandidates: async () => ([
      {
        id: 'row-a', canonical_slug: 'a', media_type: 'movie', tmdb_id: 101,
        tmdb_media_type: 'movie', mdblist_tomatoes: null, mdblist_audience: 55
      }
    ]),
    fetchRatings: async (request) => {
      if (request.ratingSource === 'audience') throw new Error('socket hang up');
      return { ...request, ratings: [{ id: '101', rating: 75 }] };
    }
  });
  const stats = await syncMdblistRatings(SOURCES, deps);
  assert.equal(stats.partial, 1);
  assert.equal(stats.errors['socket hang up'], 1);
  assert.equal(calls.results[0][1].tomatoesAttempted, true);
  assert.equal(calls.results[0][1].audienceAttempted, false);
});

test('rows without either provider id spend no MDBList request', async () => {
  const { deps, calls } = harness({
    listCandidates: async () => ([
      { id: 'row-a', canonical_slug: 'a', media_type: 'movie', tmdb_id: null, imdb_id: null }
    ])
  });
  const stats = await syncMdblistRatings(SOURCES, deps);
  assert.equal(stats.noId, 1);
  assert.equal(stats.spent, 0);
  assert.deepEqual(calls.misses, [['row-a', 'no-id']]);
});

test('stands down when MDBList is disabled', async () => {
  const { deps, calls } = harness({ enabled: false });
  const stats = await syncMdblistRatings(SOURCES, deps);
  assert.equal(stats.declined, 'disabled');
  assert.deepEqual(calls.budgets, []);
});

test('key identities are stable and never contain the key', () => {
  assert.equal(mdblistKeyId('key-1'), mdblistKeyId('key-1'));
  assert.equal(mdblistKeyId('key-1').length, 12);
  assert.notEqual(mdblistKeyId('key-1'), mdblistKeyId('key-2'));
  assert.ok(!mdblistKeyId('key-1').includes('key-1'));
});

function backfillHarness(overrides = {}) {
  const calls = { results: [], misses: [] };
  const rows = overrides.rows || [
    { id: 'm1', canonical_slug: 'm1', media_type: 'movie', tmdb_id: 1, tmdb_media_type: 'movie', imdb_id: null, mdblist_tomatoes: null, mdblist_audience: null },
    { id: 'm2', canonical_slug: 'm2', media_type: 'movie', tmdb_id: 2, tmdb_media_type: 'movie', imdb_id: null, mdblist_tomatoes: null, mdblist_audience: null }
  ];
  const deps = {
    enabled: true,
    apiKeys: ['key-1'],
    concurrency: 1,
    idsPerRequest: 1,
    batchLimit: 10,
    listBackfill: async () => rows,
    listCandidates: async () => [],
    recordResult: async (id, result) => { calls.results.push([id, result]); },
    recordMiss: async (id, status) => { calls.misses.push([id, status]); },
    reserveBudget: async (keyId, requested) => ({ granted: requested, used: requested, ceiling: 950 }),
    fetchRatings: async (request) => ({ ...request, ratings: request.ids.map((id) => ({ id, rating: 50 })) }),
    ...overrides
  };
  return { deps, calls, rows };
}

test('backfill advances the cursor to the last id it attempted', async () => {
  const { deps } = backfillHarness();
  const stats = await backfillMdblistRatings(deps);
  assert.equal(stats.selected, 2);
  assert.equal(stats.matched, 2);
  assert.deepEqual(stats.cursor, { next: 'm2', wrapped: false });
});

test('reaching the end wraps to the start so rows that became eligible behind the cursor are picked up', async () => {
  const behind = [{
    id: 'm0', canonical_slug: 'm0', media_type: 'movie', tmdb_id: null,
    tmdb_media_type: 'movie', imdb_id: null, tmdb_lookup_id: 7,
    mdblist_tomatoes: null, mdblist_audience: null
  }];
  const seen = [];
  const { deps } = backfillHarness({
    cursor: 'zzz',
    // Nothing left past the cursor, but one row is due back at the start.
    listBackfill: async (cursor) => { seen.push(cursor); return cursor ? [] : behind; }
  });
  const stats = await backfillMdblistRatings(deps);
  assert.deepEqual(seen, ['zzz', '']);
  assert.equal(stats.wrapped, true);
  assert.equal(stats.matched, 1);
  assert.deepEqual(stats.cursor, { next: 'm0', wrapped: true });
});

test('a lap with nothing due parks the cursor at the start and spends nothing', async () => {
  const { deps } = backfillHarness({ cursor: 'zzz', listBackfill: async () => [] });
  const stats = await backfillMdblistRatings(deps);
  assert.equal(stats.spent, 0);
  assert.deepEqual(stats.cursor, { next: '', wrapped: true });
});

test('backfill stops the cursor at the last attempted row when budget runs out', async () => {
  let grants = 0;
  const { deps } = backfillHarness({
    // Enough budget for m1's two sources, then nothing: m2 is never attempted.
    reserveBudget: async (keyId, requested) => {
      if (grants >= 2) return { granted: 0, used: 0, ceiling: 950 };
      grants += 1;
      return { granted: requested, used: requested, ceiling: 950 };
    }
  });
  const stats = await backfillMdblistRatings(deps);
  assert.equal(stats.declined, 'budget-exhausted');
  assert.equal(stats.cursor.wrapped, false);
  assert.equal(stats.cursor.next, 'm1');
});

test('stats format as a single greppable line', () => {
  const line = formatMdblistStats({
    visible: 40, selected: 12, batches: 4, reserved: 4, spent: 4,
    matched: 9, partial: 1, unmatched: 2, tomatoes: 7, audience: 8, noId: 0,
    keysTried: 2, keysTotal: 3, keysDrained: 1, durationMs: 800,
    declined: null, errors: { timeout: 1 }
  });
  assert.match(line, /batches=4 reserved=4 spent=4 matched=9/);
  assert.match(line, /keys=2\/3 drained=1/);
  assert.match(line, /errors=timeoutx1/);
});

test('mdblist uses tmdb_media_type for tmdb lookups', async () => {
  const fetches = [];
  const rows = [
    // typed movie by the provider, tv by TMDB: the tmdb id belongs to the tv section
    { id: 'x1', canonical_slug: 'x1', media_type: 'movie', tmdb_id: 11, tmdb_media_type: 'tv', imdb_id: null },
    // imdb lookup keeps media_type
    { id: 'x2', canonical_slug: 'x2', media_type: 'movie', tmdb_id: null, tmdb_media_type: 'tv', imdb_id: 'tt1234567' },
    // no tmdb_media_type: falls back to media_type
    { id: 'x3', canonical_slug: 'x3', media_type: 'movie', tmdb_id: 13, tmdb_media_type: null, imdb_id: null },
    // tmdb_lookup_id guess keeps media_type
    { id: 'x4', canonical_slug: 'x4', media_type: 'tv', tmdb_id: null, tmdb_media_type: null, imdb_id: null, tmdb_lookup_id: 14 }
  ];
  const { deps } = backfillHarness({
    rows,
    fetchRatings: async (request) => {
      fetches.push(request);
      return { ...request, ratings: [] };
    }
  });
  await backfillMdblistRatings(deps);
  const kinds = new Set(fetches.map((f) => f.provider + ':' + f.mediaType + ':' + f.ids.join()));
  assert.deepEqual([...kinds].sort(), [
    'imdb:movie:tt1234567', 'tmdb:movie:13', 'tmdb:show:11', 'tmdb:show:14'
  ]);
});

test('backfill stops at headroom', async () => {
  const seen = [];
  const { deps, calls } = backfillHarness({
    reserveBudget: async (keyId, requested, options) => {
      seen.push(options);
      return { granted: 0, used: 750, ceiling: 950, heldBack: true };
    }
  });
  const stats = await backfillMdblistRatings(deps);
  assert.equal(stats.declined, 'headroom');
  assert.equal(stats.spent, 0);
  assert.equal(calls.results.length, 0);
  assert.equal(stats.cursor.next, '');
  assert.ok(seen.length > 0 && seen.every((o) => o.headroom === true));
});

test('visible pass never asks for headroom', async () => {
  const seen = [];
  const h = harness({
    reserveBudget: async (keyId, requested, options) => {
      seen.push(options);
      return { granted: requested, used: requested, ceiling: 950 };
    }
  });
  await syncMdblistRatings(SOURCES, h.deps);
  assert.ok(seen.length > 0 && seen.every((o) => !o.headroom));
});

test('drain uses full ceiling', async () => {
  const reserves = [];
  const { deps } = backfillHarness({
    reserveBudget: async (keyId, requested, options) => {
      reserves.push([requested, options]);
      return { granted: requested, used: requested, ceiling: 950 };
    },
    fetchRatings: async () => { throw new MdblistQuotaError('quota'); }
  });
  const stats = await backfillMdblistRatings(deps);
  assert.equal(stats.keysDrained, 1);
  const drain = reserves.find(([requested]) => requested === 950);
  assert.ok(drain, 'drain reserves the full ceiling');
  assert.equal(drain[1], undefined, 'drain request carries no headroom option');
});

test('headroom clamped below ceiling', () => {
  assert.equal(mdblistEffectiveHeadroom(950, 200), 200);
  assert.equal(mdblistEffectiveHeadroom(150, 200), 149);
  assert.equal(mdblistEffectiveHeadroom(1, 200), 0);
  assert.equal(mdblistEffectiveHeadroom(0, 200), 0);
});

test('reserveMdblistBudget caps backfill at ceiling - headroom and flags it', async () => {
  const original = pool.connect;
  const used = { value: 750 };
  pool.connect = async () => ({
    release() {},
    async query(sql) {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ used: used.value }] };
      return { rows: [] };
    }
  });
  // config defaults: budget 1000, reserve 50 -> ceiling 950, headroom 200 -> backfill cap 750
  try {
    const held = await reserveMdblistBudget('k', 1, { headroom: true });
    assert.equal(held.granted, 0);
    assert.equal(held.heldBack, true);
    assert.equal(held.ceiling, 950);
    const visible = await reserveMdblistBudget('k', 1);
    assert.equal(visible.granted, 1);
    used.value = 950;
    const spent = await reserveMdblistBudget('k', 1, { headroom: true });
    assert.equal(spent.granted, 0);
    assert.notEqual(spent.heldBack, true);
  } finally {
    pool.connect = original;
  }
});
