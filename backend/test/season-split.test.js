import test from 'node:test';
import assert from 'node:assert/strict';
import { planSeasonSplit } from '../src/seasonSplit.js';

const row = (movie_id, canonical_slug, row_season, provider_slug, source_season) =>
  ({ movie_id, canonical_slug, row_season, provider_slug, source_season });

test('a collapsed row lists foreign seasons first and its own season last', () => {
  const plan = planSeasonSplit([
    row('a', 'archer-phan-14', 1, 'archer-phan-1', 1),
    row('a', 'archer-phan-14', 1, 'archer-phan-14', 14),
    row('a', 'archer-phan-14', 1, 'archer-phan-2', 2)
  ]);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].sources.map((s) => s.slug), ['archer-phan-2', 'archer-phan-14', 'archer-phan-1']);
});

test('rows whose sources all match the row season are left alone', () => {
  assert.deepEqual(planSeasonSplit([row('a', 'x', 2, 'x-phan-2', 2), row('a', 'x', 2, 'x-2', 2)]), []);
});

test('a row without a season treats every seasoned source as foreign', () => {
  const plan = planSeasonSplit([row('a', 'x', null, 'x-phan-1', 1), row('a', 'x', null, 'x-phan-2', 2)]);
  assert.deepEqual(plan[0].sources.map((s) => s.slug), ['x-phan-1', 'x-phan-2']);
});

test('sources without a season are ignored', () => {
  assert.deepEqual(planSeasonSplit([row('a', 'x', 1, 'x', null)]), []);
});
