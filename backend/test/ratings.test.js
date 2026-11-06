import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRatings, hasStaleTmdbScore } from '../src/ratings.js';
import { mergedMovie } from '../src/repository.js';
import { card } from '../src/viewmodels.js';

const ID = { tmdbType: 'movie', tmdbId: 55 };
const self = { tmdb: 7.4, tmdb_count: 120, tmdb_src: 'movie:55' };

test('provider null never clears tmdb or any other score', () => {
  const merged = mergeRatings({ tmdb: 6.1, tmdb_count: 9, imdb: 8, imdb_count: 100 },
    { tmdb: null, tmdb_count: 0, imdb: undefined, imdb_count: null }, ID);
  assert.deepEqual(merged, { tmdb: 6.1, tmdb_count: 9, imdb: 8, imdb_count: 100 });
});

test('provider values still fill and replace ordinary scores', () => {
  assert.deepEqual(mergeRatings({ imdb: 7 }, { imdb: 8, tmdb: 5 }, ID), { imdb: 8, tmdb: 5 });
});

test('self-fetched tmdb survives a kkphim upsert', () => {
  const merged = mergeRatings({ ...self, imdb: 7 }, { tmdb: 3.2, tmdb_count: 4, imdb: 8 }, ID);
  assert.deepEqual(merged, { ...self, imdb: 8 });
});

test('stale tmdb_src yields to the provider score and drops its mark', () => {
  const merged = mergeRatings({ tmdb: 7.4, tmdb_count: 120, tmdb_src: 'movie:99' }, { tmdb: 3.2, tmdb_count: 4 }, ID);
  assert.deepEqual(merged, { tmdb: 3.2, tmdb_count: 4 });
});

test('stale tmdb_src is dropped even when the provider sends null/0 (clear or reassigned identity)', () => {
  const stale = { tmdb: 7.4, tmdb_count: 120, tmdb_src: 'movie:99', imdb: 8 };
  assert.deepEqual(mergeRatings(stale, { tmdb: null, tmdb_count: 0 }, ID), { imdb: 8 });
  assert.deepEqual(mergeRatings(stale, null, ID), { imdb: 8 });
  // The row lost its tmdb_id altogether.
  assert.deepEqual(mergeRatings(stale, { tmdb: null }, {}), { imdb: 8 });
  assert.deepEqual(mergeRatings(stale, { tmdb: null }), { imdb: 8 });
});

test('matching tmdb_src is kept and a provider snapshot without tmdb_src is never dropped', () => {
  assert.deepEqual(mergeRatings(self, { tmdb: null, tmdb_count: 0 }, ID), self);
  const snapshot = { tmdb: 6.1, tmdb_count: 9 };
  assert.deepEqual(mergeRatings(snapshot, { tmdb: null }, {}), snapshot);
  assert.deepEqual(mergeRatings(snapshot, { tmdb: null }, ID), snapshot);
});

test('hasStaleTmdbScore only flags a mark that differs from the row identity', () => {
  assert.equal(hasStaleTmdbScore(self, 'movie', 55), false);
  assert.equal(hasStaleTmdbScore(self, 'tv', 55), true);
  assert.equal(hasStaleTmdbScore(self, null, null), true);
  assert.equal(hasStaleTmdbScore({ tmdb: 5 }, null, null), false);
  assert.equal(hasStaleTmdbScore(undefined, 'movie', 1), false);
});

test('viewmodel card does not emit a score marked for another identity', () => {
  const row = (extra) => ({ id: 'x', title: 't', canonical_slug: 's', tmdb_id: 55, tmdb_media_type: 'movie', ratings: { ...self, imdb: 8, imdb_count: 3 }, ...extra });
  assert.equal(card(row()).tmdb.vote_average, 7.4);
  assert.equal(card(row()).tmdb.vote_count, 120);
  const stale = card(row({ tmdb_id: 56 }));
  assert.equal(stale.tmdb.vote_average, null);
  assert.equal(stale.tmdb.vote_count, null);
  assert.equal(stale.imdb.vote_average, 8);
  const cleared = card(row({ tmdb_id: null, tmdb_media_type: null }));
  assert.equal(cleared.tmdb.vote_average, null);
  assert.equal(card(row({ ratings: { tmdb: 6, tmdb_count: 2 } })).tmdb.vote_average, 6, 'provider snapshot still shown');
});

test('mergedMovie wires it: self-fetched tmdb beats the provider snapshot', () => {
  const current = { title: 't', tmdb_id: 55, tmdb_media_type: 'movie', ratings: { ...self }, primary_provider: 'kkphim' };
  const merged = mergedMovie(current, { provider: 'kkphim', ratings: { tmdb: 2, tmdb_count: 1, imdb: null } });
  assert.deepEqual(merged.ratings, self);
});

test('identity merge: a null on the survivor never deletes the dropped row score', () => {
  // mergeRatings(drop, survivor): survivor wins where it has a value.
  const merged = mergeRatings({ imdb: 8, tmdb: 6 }, { imdb: null, tmdb: 7 }, ID);
  assert.deepEqual(merged, { imdb: 8, tmdb: 7 });
});

test('identity merge: the dropped row self-fetched score survives a provider survivor', () => {
  assert.deepEqual(mergeRatings(self, { tmdb: 4, tmdb_count: 2 }, ID), self);
});

test('identity merge: survivor self-fetched score beats the dropped one', () => {
  const survivor = { tmdb: 8, tmdb_count: 500, tmdb_src: 'movie:55' };
  assert.deepEqual(mergeRatings(self, survivor, ID), survivor);
});
