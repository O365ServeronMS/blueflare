import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAlerts, episodeTotalsCompatible, nguoncSeason, planDuplicateMerges, slugsAgree } from '../src/duplicateMerge.js';

let n = 0;
const row = (over) => ({ id: 'r' + (n += 1), normalized_original_title: 'archer', year: 2010, media_type: 'series', title: 'Archer', canonical_slug: 'archer', tmdb_season_number: null, tmdb_identity_status: 'ineligible', ...over });

test('season is read from the title or the slug', () => {
  assert.equal(nguoncSeason(row({ title: 'Mo (Phần 2)' })), 2);
  assert.equal(nguoncSeason(row({ title: 'Mo', canonical_slug: 'mo-phan-3-2025' })), 3);
  assert.equal(nguoncSeason(row({ title: 'Mo', canonical_slug: 'mo' })), null);
});

test('a seasonless NguonC row pairs with the season 1 KKPhim row', () => {
  const nguonc = row({});
  const kk = row({ tmdb_season_number: 1 });
  const { pairs, ambiguous } = planDuplicateMerges([nguonc], [kk]);
  assert.deepEqual(pairs.map((p) => [p.keep.id, p.drop.id]), [[kk.id, nguonc.id]]);
  assert.equal(ambiguous.length, 0);
});

test('a (Phần N) NguonC row only pairs with the matching season', () => {
  const nguonc = row({ title: 'Archer (Phần 2)' });
  const s1 = row({ tmdb_season_number: 1 });
  const s2 = row({ tmdb_season_number: 2 });
  const { pairs } = planDuplicateMerges([nguonc], [s1, s2]);
  assert.equal(pairs[0].keep.id, s2.id);
});

test('two KKPhim candidates make the pair ambiguous', () => {
  const nguonc = row({});
  const { pairs, ambiguous } = planDuplicateMerges([nguonc], [row({ tmdb_season_number: 1 }), row({})]);
  assert.equal(pairs.length, 0);
  assert.equal(ambiguous.length, 1);
});

test('two NguonC rows claiming one KKPhim row are both ambiguous', () => {
  const kk = row({ tmdb_season_number: 1 });
  const { pairs, ambiguous } = planDuplicateMerges([row({}), row({})], [kk]);
  assert.equal(pairs.length, 0);
  assert.equal(ambiguous.length, 2);
});

test('different year, type, missing title or TMDB mismatch never pair', () => {
  const kk = row({ tmdb_season_number: 1 });
  assert.equal(planDuplicateMerges([row({ year: 2011 })], [kk]).pairs.length, 0);
  assert.equal(planDuplicateMerges([row({ media_type: 'movie' })], [kk]).pairs.length, 0);
  assert.equal(planDuplicateMerges([row({ normalized_original_title: '' })], [row({ normalized_original_title: '', tmdb_season_number: 1 })]).pairs.length, 0);
  assert.equal(planDuplicateMerges([row({})], [row({ tmdb_season_number: 1, tmdb_identity_status: 'mismatch' })]).pairs.length, 0);
});

test('episode totals within 50% are compatible, larger gaps are not', () => {
  assert.equal(episodeTotalsCompatible({ episode_total: '11' }, { episode_total: '12' }), true);
  assert.equal(episodeTotalsCompatible({ episode_total: '6' }, { episode_total: '8' }), true);
  assert.equal(episodeTotalsCompatible({ episode_total: '12' }, { episode_total: '7' }), false);
  assert.equal(episodeTotalsCompatible({ episode_total: '' }, { episode_total: '24' }), true);
  const { pairs } = planDuplicateMerges([row({ episode_total: '10' })], [row({ tmdb_season_number: 1, episode_total: '24' })]);
  assert.equal(pairs.length, 0);
});

test('slug bases must agree and slug seasons must not conflict', () => {
  assert.equal(slugsAgree({ canonical_slug: 'tuoi-tre-vut-bay-2024' }, { canonical_slug: 'tuoi-tre-vut-bay' }), true);
  assert.equal(slugsAgree({ canonical_slug: 'truyen-gia' }, { canonical_slug: 'gia-truyen' }), false);
  assert.equal(slugsAgree({ canonical_slug: 'shin-samurai-den-yaiba' }, { canonical_slug: 'yaiba-huyen-thoai-samurai' }), false);
  const kk = row({ canonical_slug: 'stargate-sg1-phan-10', tmdb_season_number: 1 });
  assert.equal(planDuplicateMerges([row({ canonical_slug: 'stargate-sg1-phan-1' })], [kk]).pairs.length, 0);
});

test('a KKPhim source slug equal to the NguonC slug pairs and renames a stale canonical slug', () => {
  const kk = row({ canonical_slug: 'hoan-vi-phan-5', tmdb_season_number: 1, source_slugs: ['hoan-vi-phan-1'] });
  const nguonc = row({ canonical_slug: 'hoan-vi-phan-1', title: 'Hoán vị (Phần 1)' });
  const { pairs } = planDuplicateMerges([nguonc], [kk]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].evidence, 'source');
  assert.equal(pairs[0].renameTo, 'hoan-vi-phan-1');
});

test('two shared cast names pair differently named rows; one does not', () => {
  const kk = (people) => row({ canonical_slug: 'ten-khac', tmdb_season_number: 1, actors: people });
  const nguonc = (people) => row({ canonical_slug: 'ten-viet', actors: people });
  assert.equal(planDuplicateMerges([nguonc(['A', 'B', 'C'])], [kk(['b', 'c'])]).pairs[0].evidence, 'cast');
  assert.equal(planDuplicateMerges([nguonc(['A', 'B'])], [kk(['B', 'Z'])]).pairs.length, 0);
});

test('merge alerts fire on failures, backlog, ambiguity and stalls only', () => {
  const quiet = { remaining: 0, skipped: 0, ambiguous: 0, stalledCycles: 0, pendingThreshold: 200 };
  assert.deepEqual(mergeAlerts(quiet), []);
  assert.equal(mergeAlerts({ ...quiet, skipped: 2 }).length, 1);
  assert.equal(mergeAlerts({ ...quiet, ambiguous: 1 }).length, 1);
  assert.equal(mergeAlerts({ ...quiet, remaining: 201 }).length, 1);
  assert.equal(mergeAlerts({ ...quiet, remaining: 200 }).length, 0);
  assert.equal(mergeAlerts({ ...quiet, remaining: 5, stalledCycles: 3 }).length, 1);
});
