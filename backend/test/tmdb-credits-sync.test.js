import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshTmdbCredits } from '../src/tmdbCreditsSync.js';

const settings = { tmdbEnabled: true, tmdbCreditsEnabled: true, tmdbApiKey: 'k', tmdbCreditsLimit: 10, tmdbCreditsConcurrency: 2 };
const credits = (cast, vote = { average: 0, count: 0 }) => ({ cast, directors: [], vote });

test('credits pass returns slugs from credits and vote writes, deduplicated', async () => {
  const recorded = [];
  const slugs = await refreshTmdbCredits({
    config: settings,
    listCandidates: async () => [{ media_type: 'movie', tmdb_id: '1' }, { media_type: 'tv', tmdb_id: '2' }],
    fetchCredits: async ({ tmdbId }) => credits(tmdbId === 1 ? [{ tmdbPersonId: 1 }] : [], { average: 7, count: 10 }),
    record: async (type, id, payload) => { recorded.push([type, id, payload.status]); return id === 1 ? ['a', 'b'] : []; },
    recordVote: async (type, id) => (id === 1 ? ['b'] : ['c']),
    recordFailure: async () => assert.fail('no failure expected')
  });
  assert.deepEqual(slugs.sort(), ['a', 'b', 'c']);
  assert.deepEqual(recorded.sort(), [['movie', 1, 'ok'], ['tv', 2, 'empty']]);
});

test('credits pass returns no slug when nothing changed', async () => {
  const slugs = await refreshTmdbCredits({
    config: settings,
    listCandidates: async () => [{ media_type: 'movie', tmdb_id: '1' }],
    fetchCredits: async () => credits([]),
    record: async () => [],
    recordVote: async () => []
  });
  assert.deepEqual(slugs, []);
});

test('credits pass: a vote write failure keeps the credits fetch and its slugs', async () => {
  let failures = 0;
  const slugs = await refreshTmdbCredits({
    config: settings,
    listCandidates: async () => [{ media_type: 'movie', tmdb_id: '1' }],
    fetchCredits: async () => credits([{ tmdbPersonId: 1 }]),
    record: async () => ['a'],
    recordVote: async () => { throw new Error('db down'); },
    recordFailure: async () => { failures += 1; }
  });
  assert.deepEqual(slugs, ['a']);
  assert.equal(failures, 0);
});

test('credits pass: a 404 records not_found and returns nothing', async () => {
  const seen = [];
  const slugs = await refreshTmdbCredits({
    config: settings,
    listCandidates: async () => [{ media_type: 'movie', tmdb_id: '1' }],
    fetchCredits: async () => { throw Object.assign(new Error('x'), { status: 404 }); },
    recordFailure: async (...args) => { seen.push(args[2]); }
  });
  assert.deepEqual(slugs, []);
  assert.deepEqual(seen, ['not_found']);
});

test('credits pass is off without a key', async () => {
  assert.deepEqual(await refreshTmdbCredits({ config: { ...settings, tmdbApiKey: '' } }), []);
});
