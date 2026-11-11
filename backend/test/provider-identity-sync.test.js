import assert from 'node:assert/strict';
import test from 'node:test';
import {
  identityMetaOf, pickFindResult, refreshProviderIdClaims, resetProviderIdentityCursor, resolveProviderIdentities,
  reviewFingerprint, reviewUnchanged, seasonFromShow
} from '../src/providerIdentitySync.js';
import { claimFromMetadata } from '../src/providerIdentity.js';

const base = {
  providerTmdbMode: 'apply', providerTmdbTiers: ['fill'], providerTmdbOverwritePerDay: 300, providerTmdbBatch: 100,
  providerTmdbLookupsPerCycle: 10, providerIdsPagesPerRun: 5, providerIdsRewalkDays: 30, tmdbApiKey: 'k'
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
