import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimFromIncoming, claimFromMetadata, claimsKey, decideProviderIdentity, typeConflict
} from '../src/providerIdentity.js';

const nc = (tmdbId, mediaType = 'movie', season = null, imdbId = null) =>
  claimFromMetadata('nguonc', { tmdb_id: tmdbId, tmdb_type: mediaType, tmdb_season: season, imdb_id: imdbId });
const kk = (tmdbId, mediaType = 'movie', season = null, imdbId = null) =>
  claimFromMetadata('kkphim', { tmdb_id: String(tmdbId ?? ''), tmdb_type: mediaType, tmdb_season: season, imdb_id: imdbId });
const film = (extra = {}) => ({ id: 'm1', title: 'Người Mẹ Khác', canonical_slug: 'nguoi-me-khac', display_type: 'single', media_type: 'movie', tmdb_id: null, tmdb_media_type: null, tmdb_season_number: null, imdb_id: null, ...extra });
const show = (extra = {}) => film({ title: 'Nhà Ngoại Giao', canonical_slug: 'nha-ngoai-giao', display_type: 'series', media_type: 'tv', ...extra });
const decide = (row, ...claims) => decideProviderIdentity({ row, claims });

test('claims read the normalized metadata; tv-only seasons, junk dropped', () => {
  assert.deepEqual(kk(55, 'tv', 2, 'tt0000123'), { provider: 'kkphim', tmdbId: 55, mediaType: 'tv', season: 2, imdbId: 'tt0000123' });
  assert.deepEqual(nc(55, 'movie', 2), { provider: 'nguonc', tmdbId: 55, mediaType: 'movie', season: null, imdbId: null });
  assert.equal(nc(55, 'serie').tmdbId, null);
  assert.equal(nc(55, 'tv', 0).season, null);
  assert.equal(claimFromMetadata('nguonc', null).tmdbId, null);
  assert.deepEqual(claimFromIncoming({ provider: 'nguonc', tmdbId: 7, tmdbMediaType: 'tv', tmdbSeasonNumber: 3, imdbId: null }),
    { provider: 'nguonc', tmdbId: 7, mediaType: 'tv', season: 3, imdbId: null });
});

test('nobody names an id: none, or a TMDB /find when an IMDb id is known', () => {
  assert.equal(decide(film(), nc(null)).action, 'none');
  assert.deepEqual(decide(film({ imdb_id: 'tt1234567' }), nc(null)), { action: 'find', imdbId: 'tt1234567', imdb: null });
  const fromClaim = decide(film(), nc(null, 'movie', null, 'tt7654321'));
  assert.equal(fromClaim.action, 'find');
  assert.equal(fromClaim.imdbId, 'tt7654321');
  assert.deepEqual(fromClaim.imdb, { action: 'fill', imdbId: 'tt7654321' });
  assert.equal(decide(film({ tmdb_id: 9, tmdb_media_type: 'movie', imdb_id: 'tt1234567' }), nc(null)).action, 'none');
});

test('empty row: one provider or two agreeing fill it', () => {
  assert.deepEqual(decide(film(), nc(10)).identity, { id: 10, mediaType: 'movie', season: null });
  assert.equal(decide(film(), nc(10)).tier, 'fill');
  assert.equal(decide(film(), nc(10)).reason, 'single-provider');
  assert.equal(decide(film(), nc(10), kk(10)).reason, 'providers-agree');
});

test('providers naming different ids never write: both go to the AI as candidates', () => {
  const d = decide(film({ tmdb_id: 3, tmdb_media_type: 'movie', tmdb_id_source: 'inferred' }), nc(10), kk(11));
  assert.equal(d.action, 'queue');
  assert.equal(d.reason, 'providers-disagree');
  assert.deepEqual(d.candidates, [{ id: 10, type: 'movie' }, { id: 11, type: 'movie' }, { id: 3, type: 'movie' }]);
});

test('row holds another id: two agreeing providers overwrite, a single one goes to the AI', () => {
  const row = film({ tmdb_id: 3, tmdb_media_type: 'movie', tmdb_id_source: 'inferred' });
  const agreed = decide(row, nc(10), kk(10));
  assert.equal(agreed.action, 'assign');
  assert.equal(agreed.tier, 'overwrite');
  assert.deepEqual(agreed.identity, { id: 10, mediaType: 'movie', season: null });
  const single = decide(row, nc(10), kk(null));
  assert.equal(single.action, 'queue');
  assert.equal(single.reason, 'single-vs-existing');
  assert.deepEqual(single.candidates, [{ id: 10, type: 'movie' }, { id: 3, type: 'movie' }]);
  assert.equal(decide(row, nc(3)).action, 'noop');
  assert.equal(decide(row, nc(3), kk(3)).action, 'noop');
});

test('a pinned row is never rewritten, only reported', () => {
  const row = film({ tmdb_id: 3, tmdb_media_type: 'movie', tmdb_identity_pinned: true });
  assert.deepEqual([decide(row, nc(10), kk(10)).action, decide(row, nc(10), kk(10)).reason], ['blocked', 'pinned']);
  assert.equal(decide(row, nc(10), kk(11)).action, 'blocked');
  assert.equal(decide(row, nc(3)).action, 'noop');
  assert.equal(decide(film({ tmdb_identity_pinned: true }), nc(10)).action, 'blocked');
});

test('a type that contradicts the display type is never written; animation is never flagged', () => {
  assert.equal(typeConflict({ display_type: 'single' }, 'tv'), true);
  assert.equal(typeConflict({ display_type: 'series' }, 'movie'), true);
  assert.equal(typeConflict({ display_type: 'hoathinh' }, 'movie'), false);
  assert.equal(typeConflict({ display_type: 'hoathinh' }, 'tv'), false);
  const d = decide(film(), nc(10, 'tv', 1), kk(10, 'tv', 1));
  assert.equal(d.action, 'queue');
  assert.equal(d.reason, 'type-mismatch');
  const anime = decide(show({ display_type: 'hoathinh' }), nc(10, 'movie'));
  assert.equal(anime.action, 'assign');
  assert.deepEqual(anime.identity, { id: 10, mediaType: 'movie', season: null });
});

test('tv seasons: set beats null, null never clears, the title settles a disagreement', () => {
  // Empty row, no season anywhere: resolve through TMDB /tv.
  assert.deepEqual(decide(show(), nc(20, 'tv')), { action: 'resolve-season', tier: 'fill', identity: { id: 20, mediaType: 'tv', season: null }, reason: 'season-unknown', imdb: null });
  // A set season beats a null one.
  assert.deepEqual(decide(show(), nc(20, 'tv'), kk(20, 'tv', 2)).identity, { id: 20, mediaType: 'tv', season: 2 });
  // The title marker alone gives the season.
  assert.equal(decide(show({ title: 'Nhà Ngoại Giao (Phần 3)' }), nc(20, 'tv')).identity.season, 3);
  // A provider null season never clears the stored season.
  assert.equal(decide(show({ tmdb_id: 20, tmdb_media_type: 'tv', tmdb_season_number: 2 }), nc(20, 'tv')).action, 'noop');
  // Providers disagree on the season: the "(Phần N)" marker wins (the Superman Phần 3 case).
  const titled = decide(show({ title: 'Superman (Phần 3)' }), nc(30, 'tv', 3), kk(30, 'tv', 1));
  assert.deepEqual([titled.action, titled.identity.season], ['assign', 3]);
  // No marker: queued for the catalog audit.
  const untitled = decide(show(), nc(30, 'tv', 3), kk(30, 'tv', 1));
  assert.deepEqual([untitled.action, untitled.reason, untitled.seasons], ['queue', 'season-disagree', [1, 3]]);
  // One provider season against the title marker: queued, unless the row already says the marker.
  assert.equal(decide(show({ title: 'X (Phần 3)' }), kk(30, 'tv', 1)).reason, 'season-vs-title');
  assert.equal(decide(show({ title: 'X (Phần 3)', tmdb_id: 30, tmdb_media_type: 'tv', tmdb_season_number: 3 }), kk(30, 'tv', 1)).action, 'noop');
});

test('tv season of the same id: fill an empty season, rewrite a set one only on two signals', () => {
  const nullSeason = show({ tmdb_id: 20, tmdb_media_type: 'tv', tmdb_season_number: null });
  assert.deepEqual([decide(nullSeason, kk(20, 'tv', 2)).tier, decide(nullSeason, kk(20, 'tv', 2)).identity.season], ['fill', 2]);
  assert.equal(decide(nullSeason, nc(20, 'tv')).action, 'resolve-season');
  const s1 = show({ tmdb_id: 20, tmdb_media_type: 'tv', tmdb_season_number: 1 });
  assert.equal(decide(s1, kk(20, 'tv', 2)).reason, 'season-single-dissent');
  const agreed = decide(s1, kk(20, 'tv', 2), nc(20, 'tv', 2));
  assert.deepEqual([agreed.action, agreed.tier, agreed.identity.season], ['assign', 'season', 2]);
  const titled = decide({ ...s1, title: 'Nhà Ngoại Giao (Phần 2)' }, kk(20, 'tv', 2));
  assert.deepEqual([titled.tier, titled.identity.season], ['season', 2]);
});

test('row holds another tv id and both providers agree without a season: resolve, then overwrite', () => {
  const d = decide(show({ tmdb_id: 5, tmdb_media_type: 'tv', tmdb_season_number: 1 }), nc(20, 'tv'), kk(20, 'tv'));
  assert.deepEqual([d.action, d.tier], ['resolve-season', 'overwrite']);
});

test('imdb: fill when empty, conflict when the row holds another', () => {
  assert.deepEqual(decide(film(), nc(10, 'movie', null, 'tt1111111')).imdb, { action: 'fill', imdbId: 'tt1111111' });
  assert.equal(decide(film({ imdb_id: 'tt1111111' }), nc(10, 'movie', null, 'tt1111111')).imdb, null);
  assert.deepEqual(decide(film({ imdb_id: 'tt1111111' }), nc(10, 'movie', null, 'tt2222222')).imdb,
    { action: 'conflict', imdbId: 'tt2222222', have: 'tt1111111' });
  assert.equal(decide(film(), nc(10, 'movie', null, 'tt1111111'), kk(10, 'movie', null, 'tt2222222')).imdb.action, 'conflict');
});

test('claimsKey changes only when what providers claim changes', () => {
  assert.equal(claimsKey([nc(10), kk(11)]), claimsKey([kk(11), nc(10)]));
  assert.notEqual(claimsKey([nc(10), kk(11)]), claimsKey([nc(10), kk(12)]));
  assert.equal(claimsKey([nc(null)]), '');
});

test('providerYearCheck: existence, year within one, unaired passes, later seasons use their own date', async () => {
  const { providerYearCheck } = await import('../src/providerIdentity.js');
  const movie = { id: 1, mediaType: 'movie', season: null };
  assert.equal(providerYearCheck({ year: 2024 }, movie, null), 'tmdb-missing');
  assert.equal(providerYearCheck({ year: 2024 }, movie, { release_date: '2023-12-01' }), null);
  assert.equal(providerYearCheck({ year: 2024 }, movie, { release_date: '2011-01-01' }), 'tmdb-year-2011');
  assert.equal(providerYearCheck({ year: 2024 }, movie, { release_date: '' }), null);
  assert.equal(providerYearCheck({ year: null }, movie, { release_date: '2011-01-01' }), null);
  const show = { first_air_date: '2015-01-01', seasons: [{ season_number: 3, air_date: '2024-03-01' }, { season_number: 4, air_date: null }] };
  assert.equal(providerYearCheck({ year: 2024 }, { id: 1, mediaType: 'tv', season: 3 }, show), null);
  assert.equal(providerYearCheck({ year: 2026 }, { id: 1, mediaType: 'tv', season: 4 }, show), null);
  assert.equal(providerYearCheck({ year: 2024 }, { id: 1, mediaType: 'tv', season: 1 }, show), 'tmdb-year-2015');
});
