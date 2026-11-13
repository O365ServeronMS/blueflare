import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUpsertIdentityGuard, identityMetaOf, pickFindResult, refreshProviderIdClaims, resetProviderIdentityCursor, resolveProviderIdentities,
  reviewFingerprint, reviewUnchanged, seasonFromShow
} from '../src/providerIdentitySync.js';
import { claimFromMetadata } from '../src/providerIdentity.js';

const base = {
  providerTmdbMode: 'apply', providerTmdbTiers: ['fill'], providerTmdbOverwritePerDay: 300, providerTmdbBatch: 100,
  providerTmdbLookupsPerCycle: 10, providerTmdbVerify: false, providerIdsPagesPerRun: 5, providerIdsRewalkDays: 30, tmdbApiKey: 'k'
};
const film = (extra = {}) => ({
  id: 'm1', title: 'Phim', canonical_slug: 'phim', display_type: 'single', media_type: 'movie', year: 2024, episode_total: '1',
  tmdb_id: null, tmdb_media_type: null, tmdb_season_number: null, imdb_id: null, tmdb_identity_pinned: null, provider_claims: [], ...extra
});
const show = (extra = {}) => film({ title: 'Bộ', canonical_slug: 'bo', display_type: 'series', media_type: 'tv', episode_total: '10', ...extra });
const claim = (provider, tmdbId, type = 'movie', season = null, imdb = null) =>
  ({ provider, meta: { tmdb_id: tmdbId, tmdb_type: type, tmdb_season: season, imdb_id: imdb } });

function harness(rows, settings = {}, extra = {}) {
  resetProviderIdentityCursor();
  const saved = [];
  const assigns = [];
  const imdb = [];
  const deps = {
    settings: { ...base, ...settings },
    list: async () => rows,
    save: async (entry) => { saved.push(entry); },
    assign: async (movieId, input, options) => {
      assigns.push({ movieId, input, options });
      if (options.mode === 'dry-run') return { action: 'planned', plan: 'assign', survivorId: movieId };
      return { action: 'assigned', survivorId: movieId, survivorSlug: 'slug-' + movieId };
    },
    countOverwrites: async () => 0,
    fillImdb: async (row, id) => { imdb.push([row.id, id]); return true; },
    client: { get: async () => null },
    ...extra
  };
  return { deps, saved, assigns, imdb };
}

test('list items: only identity keys travel, records naming no id are skipped', () => {
  assert.equal(identityMetaOf({ metadata: { title: 'x' } }), null);
  assert.deepEqual(identityMetaOf({ metadata: { title: 'x', tmdb_id: 5, tmdb_type: 'tv', imdb_id: 'tt0012345' } }),
    { tmdb_id: 5, tmdb_type: 'tv', imdb_id: 'tt0012345' });
});

test('list walk pages through, saves the checkpoint and stops at the last page', async () => {
  const updates = [];
  const saves = [];
  const provider = {
    name: 'nguonc',
    list: async (_type, page) => ({ data: { page, items: page <= 2 ? [{ slug: 's' + page, tmdb: page }] : [] } }),
    listItems: (data) => data.items
  };
  const stats = await refreshProviderIdClaims({
    settings: base,
    providers: [provider],
    normalize: (_p, item) => ({ providerSlug: item.slug, metadata: { tmdb_id: item.tmdb, tmdb_type: 'movie' } }),
    getCheckpoint: async () => ({ next_page: 1, completed_at: null }),
    saveCheckpoint: async (_name, _lane, checkpoint) => { saves.push(checkpoint); },
    recordFailure: async () => {},
    resetCheckpoint: async () => false,
    update: async (name, entries) => { updates.push([name, entries]); return entries.length; },
    totalPages: () => 2
  });
  assert.deepEqual([stats.pages, stats.updated], [2, 2]);
  assert.deepEqual(saves.map((s) => [s.nextPage, s.completed]), [[2, false], [3, true]]);
  assert.deepEqual(updates[0], ['nguonc', [{ slug: 's1', meta: { tmdb_id: 1, tmdb_type: 'movie' } }]]);
});

test('list walk does nothing when the mode is off or a walk is complete', async () => {
  const off = await refreshProviderIdClaims({ settings: { ...base, providerTmdbMode: 'off' }, providers: [{ name: 'x' }] });
  assert.equal(off.pages, 0);
  const done = await refreshProviderIdClaims({
    settings: base, providers: [{ name: 'x', list: () => { throw new Error('no'); } }],
    getCheckpoint: async () => ({ completed_at: new Date() }), resetCheckpoint: async () => false
  });
  assert.equal(done.pages, 0);
});

test('fill tier on: an empty row gets the provider id with source provider, guard and pin respected', async () => {
  const h = harness([film({ provider_claims: [claim('nguonc', 10), claim('kkphim', 10)] })]);
  const stats = await resolveProviderIdentities(h.deps);
  assert.equal(stats.assigned, 1);
  const { input, options } = h.assigns[0];
  assert.deepEqual(input, { tmdbId: 10, mediaType: 'movie', season: null });
  assert.equal(options.source, 'provider');
  assert.equal(options.mode, 'apply');
  assert.deepEqual([options.guard, options.respectPin, options.replace, options.allowMerge], [true, true, false, false]);
  assert.equal(options.evidence.tier, 'fill');
  assert.deepEqual(stats.slugs, ['slug-m1']);
  assert.equal(h.saved[0].status, 'done');
});

test('a tier that is not enabled only plans, and dry-run plans everything', async () => {
  const overwrite = film({ tmdb_id: 3, tmdb_media_type: 'movie', provider_claims: [claim('nguonc', 10), claim('kkphim', 10)] });
  const h = harness([overwrite]);
  const stats = await resolveProviderIdentities(h.deps);
  assert.equal(stats.planned, 1);
  assert.equal(h.assigns[0].options.mode, 'dry-run');
  assert.equal(h.assigns[0].options.replace, true);
  assert.equal(h.saved[0].status, 'planned');
  assert.equal(h.saved[0].tier, 'overwrite');

  const dry = harness([film({ provider_claims: [claim('nguonc', 10)] })], { providerTmdbMode: 'dry-run' });
  await resolveProviderIdentities(dry.deps);
  assert.equal(dry.assigns[0].options.mode, 'dry-run');
});

test('the overwrite cap stops season/overwrite writes for the day without a fingerprint', async () => {
  const rows = [
    film({ id: 'a', tmdb_id: 3, tmdb_media_type: 'movie', provider_claims: [claim('nguonc', 10), claim('kkphim', 10)] }),
    film({ id: 'b', tmdb_id: 4, tmdb_media_type: 'movie', provider_claims: [claim('nguonc', 11), claim('kkphim', 11)] })
  ];
  const h = harness(rows, { providerTmdbTiers: ['fill', 'overwrite'], providerTmdbOverwritePerDay: 1 });
  const stats = await resolveProviderIdentities(h.deps);
  assert.deepEqual([stats.assigned, stats.capped], [1, 1]);
  assert.deepEqual(h.saved.map((s) => s.movieId), ['a']);
});

test('disagreeing providers are queued pending for the AI match with both ids', async () => {
  const h = harness([film({ provider_claims: [claim('nguonc', 10), claim('kkphim', 11)] })]);
  const stats = await resolveProviderIdentities(h.deps);
  assert.equal(stats.queued, 1);
  assert.equal(h.assigns.length, 0);
  assert.deepEqual([h.saved[0].status, h.saved[0].reason], ['pending', 'providers-disagree']);
  assert.deepEqual(h.saved[0].candidates, [{ id: 10, type: 'movie' }, { id: 11, type: 'movie' }]);
});

test('a tv id without season: one TMDB season gives season 1, otherwise queued unresolved', async () => {
  const one = harness([show({ provider_claims: [claim('nguonc', 20, 'tv')] })], {}, { client: { get: async () => ({ number_of_seasons: 1, seasons: [] }) } });
  await resolveProviderIdentities(one.deps);
  assert.deepEqual(one.assigns[0].input, { tmdbId: 20, mediaType: 'tv', season: 1 });
  const many = harness([show({ provider_claims: [claim('nguonc', 20, 'tv')] })], {}, { client: { get: async () => ({ number_of_seasons: 3, seasons: [] }) } });
  await resolveProviderIdentities(many.deps);
  assert.equal(many.assigns.length, 0);
  assert.deepEqual([many.saved[0].status, many.saved[0].reason], ['pending', 'season-unresolved']);
});

test('the TMDB lookup budget defers the row without recording it', async () => {
  const rows = [show({ id: 'a', provider_claims: [claim('nguonc', 20, 'tv')] }), show({ id: 'b', provider_claims: [claim('nguonc', 21, 'tv')] })];
  const h = harness(rows, { providerTmdbLookupsPerCycle: 1 }, { client: { get: async () => ({ number_of_seasons: 1 }) } });
  const stats = await resolveProviderIdentities(h.deps);
  assert.deepEqual([stats.assigned, stats.capped, stats.lookups], [1, 1, 1]);
  assert.deepEqual(h.saved.map((s) => s.movieId), ['a']);
});

test('an IMDb id alone is resolved through /find when the result is unique and fits the type', async () => {
  const calls = [];
  const client = { get: async (path) => { calls.push(path); return { movie_results: [{ id: 77 }], tv_results: [] }; } };
  const h = harness([film({ imdb_id: 'tt1234567' })], {}, { client });
  await resolveProviderIdentities(h.deps);
  assert.equal(calls[0], '/find/tt1234567?external_source=imdb_id');
  assert.deepEqual(h.assigns[0].input, { tmdbId: 77, mediaType: 'movie', season: null });
  assert.equal(h.assigns[0].options.evidence.reason, 'imdb-find');

  const clash = harness([film({ imdb_id: 'tt1234567' })], {}, { client: { get: async () => ({ movie_results: [], tv_results: [{ id: 5 }] }) } });
  await resolveProviderIdentities(clash.deps);
  assert.equal(clash.assigns.length, 0);
  assert.deepEqual([clash.saved[0].status, clash.saved[0].reason], ['blocked', 'find-type-mismatch']);
  assert.equal(pickFindResult({ movie_results: [{ id: 1 }], tv_results: [{ id: 2 }] }), null);
});

test('imdb is filled only with the fill tier, and a conflict is only reported', async () => {
  const h = harness([film({ provider_claims: [claim('nguonc', 10, 'movie', null, 'tt1111111')] })]);
  await resolveProviderIdentities(h.deps);
  assert.deepEqual(h.imdb, [['m1', 'tt1111111']]);
  const off = harness([film({ provider_claims: [claim('nguonc', 10, 'movie', null, 'tt1111111')] })], { providerTmdbTiers: [] });
  await resolveProviderIdentities(off.deps);
  assert.deepEqual(off.imdb, []);
  const conflict = harness([film({ imdb_id: 'tt2222222', tmdb_id: 10, tmdb_media_type: 'movie', provider_claims: [claim('nguonc', 10, 'movie', null, 'tt1111111')] })]);
  await resolveProviderIdentities(conflict.deps);
  assert.deepEqual(conflict.imdb, []);
  assert.match(conflict.saved[0].outcome, /imdb-conflict/);
});

test('merge-disabled waits as planned until the merge tier is on', async () => {
  const h = harness([film({ provider_claims: [claim('nguonc', 10)] })], {}, {
    assign: async () => ({ action: 'blocked', reason: 'merge-disabled', holderSlug: 'other', survivorId: 'm1' })
  });
  const stats = await resolveProviderIdentities(h.deps);
  assert.equal(stats.planned, 1);
  assert.deepEqual([h.saved[0].status, h.saved[0].outcome], ['planned', 'would-merge:other']);
});

test('unchanged fingerprint is skipped; an AI-settled review stays settled until claims change', async () => {
  const row = film({ provider_claims: [claim('nguonc', 10), claim('kkphim', 11)] });
  const claims = row.provider_claims.map((c) => claimFromMetadata(c.provider, c.meta));
  const key = reviewFingerprint(row, claims, base);
  assert.equal(reviewUnchanged({ ...row, review_key: key }, key), true);
  const moved = reviewFingerprint({ ...row, tmdb_id: 10, tmdb_media_type: 'movie' }, claims, base);
  assert.equal(reviewUnchanged({ review_key: key, review_status: 'done', review_outcome: 'ai-assigned' }, moved), true);
  assert.equal(reviewUnchanged({ review_key: key, review_status: 'pending' }, moved), false);
  const h = harness([{ ...row, review_key: key }]);
  const stats = await resolveProviderIdentities(h.deps);
  assert.equal(stats.skipped, 1);
});

test('seasonFromShow: the title marker first, then one season, then the inference', () => {
  assert.deepEqual(seasonFromShow({ title: 'X (Phần 2)' }, null), { season: 2 });
  assert.deepEqual(seasonFromShow({ title: 'X' }, { number_of_seasons: 1 }), { season: 1 });
  assert.equal(seasonFromShow({ title: 'X', year: 2020, episode_total: '10' }, { number_of_seasons: 2, seasons: [] }).season, null);
});

test('a merge under the fill tier counts against the daily cap; once over it, merges wait without a fingerprint', async () => {
  const rows = [
    film({ id: 'a', provider_claims: [claim('nguonc', 10)] }),
    film({ id: 'b', provider_claims: [claim('nguonc', 11)] }),
    film({ id: 'c', provider_claims: [claim('nguonc', 12)] })
  ];
  const seen = [];
  const h = harness(rows, { providerTmdbTiers: ['fill', 'merge'], providerTmdbOverwritePerDay: 1 }, {
    assign: async (movieId, _input, options) => {
      seen.push([movieId, options.allowMerge]);
      if (!options.allowMerge) return { action: 'blocked', reason: 'merge-disabled', holderSlug: 'h', survivorId: movieId };
      return { action: 'merged', survivorId: movieId, survivorSlug: 's-' + movieId, dropSlug: 'd-' + movieId };
    }
  });
  const stats = await resolveProviderIdentities(h.deps);
  assert.deepEqual(seen, [['a', true], ['b', false], ['c', false]]);
  assert.deepEqual([stats.merged, stats.capped], [1, 2]);
  assert.deepEqual(h.saved.map((s) => s.movieId), ['a']);
});

test('a merge that deletes the row being decided saves no review for it and the pass goes on', async () => {
  const rows = [
    film({ id: 'a', provider_claims: [claim('nguonc', 10)] }),
    film({ id: 'b', provider_claims: [claim('nguonc', 11)] })
  ];
  const h = harness(rows, { providerTmdbTiers: ['fill', 'merge'] }, {
    assign: async (movieId) => movieId === 'a'
      ? { action: 'merged', survivorId: 'h', survivorSlug: 'holder', dropId: 'a', dropSlug: 'drop-a' }
      : { action: 'assigned', survivorId: movieId, survivorSlug: 'slug-' + movieId }
  });
  const stats = await resolveProviderIdentities(h.deps);
  assert.deepEqual([stats.merged, stats.assigned], [1, 1]);
  assert.deepEqual(h.saved.map((s) => s.movieId), ['b']);
  assert.deepEqual(stats.slugs.sort(), ['drop-a', 'holder', 'slug-b']);
});

test('verify on: a one-provider fill is written only when the TMDB title exists and fits the year', async () => {
  const rows = [
    film({ id: 'ok', year: 2024, provider_claims: [claim('kkphim', 10)] }),
    film({ id: 'old', year: 2023, provider_claims: [claim('kkphim', 11)] }),
    film({ id: 'gone', year: 2021, provider_claims: [claim('nguonc', 12)] }),
    film({ id: 'both', year: 2010, provider_claims: [claim('nguonc', 13), claim('kkphim', 13)] })
  ];
  const paths = [];
  const bodies = { '/movie/10': { release_date: '2025-02-01' }, '/movie/11': { release_date: '2011-05-05' }, '/movie/12': null };
  const h = harness(rows, { providerTmdbVerify: true }, { client: { get: async (path) => { paths.push(path); return bodies[path]; } } });
  const stats = await resolveProviderIdentities(h.deps);
  assert.deepEqual(h.assigns.map((a) => a.movieId), ['ok', 'both']);
  assert.deepEqual(paths, ['/movie/10', '/movie/11', '/movie/12']);
  assert.equal(stats.queued, 2);
  const queued = h.saved.filter((s) => s.reason === 'provider-unverified');
  assert.deepEqual(queued.map((s) => [s.movieId, s.status, s.outcome]), [['old', 'pending', 'tmdb-year-2011'], ['gone', 'pending', 'tmdb-missing']]);
  assert.deepEqual(queued[0].candidates, [{ id: 11, type: 'movie' }]);
});

test('verify on: a tv season-unknown fill reuses the /tv body and checks the picked season year', async () => {
  const rows = [
    show({ id: 'k', year: 2023, tmdb_id: 35353, tmdb_media_type: 'tv', provider_claims: [claim('kkphim', 35353, 'tv')] }),
    show({ id: 'n', year: 2024, provider_claims: [claim('kkphim', 50, 'tv')] })
  ];
  const paths = [];
  const bodies = {
    '/tv/35353': { number_of_seasons: 1, first_air_date: '2011-01-01', seasons: [{ season_number: 1, air_date: '2011-01-01' }] },
    '/tv/50': { number_of_seasons: 1, first_air_date: '', seasons: [{ season_number: 1, air_date: null }] }
  };
  const h = harness(rows, { providerTmdbVerify: true }, { client: { get: async (path) => { paths.push(path); return bodies[path]; } } });
  await resolveProviderIdentities(h.deps);
  assert.deepEqual(paths, ['/tv/35353', '/tv/50']);
  assert.deepEqual(h.assigns.map((a) => [a.movieId, a.input.season]), [['n', 1]]);
  assert.equal(h.saved.find((s) => s.movieId === 'k').reason, 'provider-unverified');
});

test('the stored key describes the row after its own imdb and tmdb writes', async () => {
  const row = film({ provider_claims: [claim('kkphim', 10, 'movie', null, 'tt1234567')] });
  const h = harness([row]);
  await resolveProviderIdentities(h.deps);
  const after = { ...row, tmdb_id: 10, tmdb_media_type: 'movie', tmdb_season_number: null, imdb_id: 'tt1234567' };
  const claims = row.provider_claims.map((entry) => claimFromMetadata(entry.provider, entry.meta));
  assert.equal(h.saved[0].key, reviewFingerprint(after, claims, { ...h.deps.settings }));
  assert.equal(reviewUnchanged({ ...after, review_key: h.saved[0].key }, reviewFingerprint(after, claims, h.deps.settings)), true);
});

// ---- upsert guard ----------------------------------------------------------------------------

function guardHarness({ existing = null, bodies = {}, settings = {} } = {}) {
  const gets = [];
  const db = { query: async () => ({ rows: existing ? [existing] : [] }) };
  const client = { get: async (path) => { gets.push(path); if (path in bodies) return bodies[path]; throw new Error('404'); } };
  const guard = createUpsertIdentityGuard({ settings: { ...base, providerTmdbVerify: true, ...settings }, db, client });
  return { guard, gets };
}
const incomingFilm = (extra = {}) => ({ provider: 'kkphim', providerSlug: 'phim', year: 2020, tmdbId: 10, tmdbMediaType: 'movie', tmdbSeasonNumber: null, imdbId: 'tt1', ...extra });

test('upsert guard: a fitting TMDB year keeps the tuple, one lookup per title', async () => {
  const { guard, gets } = guardHarness({ bodies: { '/movie/10': { release_date: '2020-05-01' } } });
  assert.equal((await guard(incomingFilm())).tmdbId, 10);
  assert.equal((await guard(incomingFilm({ providerSlug: 'other' }))).tmdbId, 10);
  assert.deepEqual(gets, ['/movie/10']);
});

test('upsert guard: a distant year, a 404 or an exhausted budget strips the tuple but keeps imdb', async () => {
  const far = guardHarness({ bodies: { '/movie/10': { release_date: '1999-01-01' } } });
  const out = await far.guard(incomingFilm());
  assert.deepEqual([out.tmdbId, out.tmdbMediaType, out.tmdbSeasonNumber, out.imdbId], [null, null, null, 'tt1']);
  assert.equal((await guardHarness().guard(incomingFilm())).tmdbId, null);
  const capped = guardHarness({ bodies: { '/movie/10': { release_date: '2020-01-01' } }, settings: { providerTmdbLookupsPerCycle: 0 } });
  assert.equal((await capped.guard(incomingFilm())).tmdbId, null);
});

test('upsert guard: no lookup when nothing would be filled', async () => {
  const held = guardHarness({ existing: { year: 2020, tmdb_id: 99, tmdb_media_type: 'movie', tmdb_season_number: null, tmdb_identity_pinned: false } });
  assert.equal((await held.guard(incomingFilm())).tmdbId, 10);
  const pinned = guardHarness({ existing: { year: 2020, tmdb_id: null, tmdb_identity_pinned: true } });
  assert.equal((await pinned.guard(incomingFilm())).tmdbId, 10);
  const none = guardHarness();
  assert.equal((await none.guard(incomingFilm({ tmdbId: null }))).tmdbId, null);
  const nguonc = guardHarness({ settings: { providerTmdbTiers: [] } });
  assert.equal((await nguonc.guard(incomingFilm({ provider: 'nguonc' }))).imdbId, 'tt1');
  assert.deepEqual([...held.gets, ...pinned.gets, ...none.gets, ...nguonc.gets], []);
  const off = guardHarness({ settings: { providerTmdbVerify: false } });
  assert.equal((await off.guard(incomingFilm())).tmdbId, 10);
  assert.deepEqual(off.gets, []);
});

test('upsert guard: a tv season is checked against that season\'s air date', async () => {
  const body = { first_air_date: '2010-01-01', seasons: [{ season_number: 2, air_date: '2020-03-01' }] };
  const ok = guardHarness({ bodies: { '/tv/7': body } });
  assert.equal((await ok.guard(incomingFilm({ tmdbId: 7, tmdbMediaType: 'tv', tmdbSeasonNumber: 2 }))).tmdbId, 7);
  const bad = guardHarness({ bodies: { '/tv/7': body } });
  assert.equal((await bad.guard(incomingFilm({ tmdbId: 7, tmdbMediaType: 'tv', tmdbSeasonNumber: 2, year: 2012 }))).tmdbId, null);
});
