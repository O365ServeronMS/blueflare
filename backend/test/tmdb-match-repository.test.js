import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import {
  listTmdbMatchCandidates,
  recordTmdbMatch,
  recordTmdbMatchFailure
} from '../src/repository.js';

function capture(rows = []) {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows }; };
  return { calls, restore: () => { pool.query = original; } };
}

test('recordTmdbMatch: verified stores match_* and never touches tmdb_id', async () => {
  const c = capture([{ canonical_slug: 'x' }]);
  try {
    const row = await recordTmdbMatch('m1', {
      status: 'verified', match: { mediaType: 'movie', tmdbId: 42 }, evidence: { overlap: 3 }
    });
    assert.equal(row.canonical_slug, 'x');
    const { sql, params } = c.calls[0];
    assert.doesNotMatch(sql, /tmdb_id\s*=|tmdb_identity_status/);
    assert.deepEqual(params.slice(0, 4), ['m1', 'verified', 42, 'movie']);
    assert.equal(params[4], JSON.stringify({ overlap: 3 }));
  } finally { c.restore(); }
});

test('recordTmdbMatch: non-verified verdicts drop any match id', async () => {
  const c = capture([]);
  try {
    await recordTmdbMatch('m1', { status: 'tie', match: { mediaType: 'movie', tmdbId: 9 } });
    assert.deepEqual(c.calls[0].params.slice(0, 4), ['m1', 'error', null, null]);
    await recordTmdbMatch('m1', { status: 'none', match: { mediaType: 'movie', tmdbId: 9 }, evidence: null });
    assert.deepEqual(c.calls[1].params.slice(0, 5), ['m1', 'none', null, null, null]);
  } finally { c.restore(); }
});

test('recordTmdbMatchFailure: never downgrades a verified row', async () => {
  const c = capture();
  try {
    await recordTmdbMatchFailure('m1', 'x'.repeat(900));
    const { sql, params } = c.calls[0];
    assert.match(sql, /CASE WHEN tmdb_match_status='verified' THEN 'verified'/);
    assert.equal(params[1].length, 500);
  } finally { c.restore(); }
});

test('listTmdbMatchCandidates: parameters line up with placeholders', async () => {
  const c = capture([{ id: 'a' }]);
  try {
    const rows = await listTmdbMatchCandidates(5);
    assert.equal(rows.length, 1);
    const { sql, params } = c.calls[0];
    assert.match(sql, /tmdb_id IS NULL/);
    assert.deepEqual(params[0], ['trung-quoc', 'hong-kong', 'nhat-ban', 'han-quoc', 'thai-lan']);
    assert.equal(params[3], 5);
    const max = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(max, params.length);
  } finally { c.restore(); }
});

import { listPersonMovies, listTmdbCreditCandidates } from '../src/repository.js';

test('listPersonMovies: both joins present and placeholders match params', async () => {
  for (const role of ['all', 'cast']) {
    const c = capture([{ count: 0 }]);
    try {
      await listPersonMovies('p1', { role, page: 1 });
      for (const { sql, params } of c.calls) {
        assert.match(sql, /m\.tmdb_id=c\.tmdb_id/);
        assert.match(sql, /m\.tmdb_match_id=c\.tmdb_id/);
        assert.match(sql, /DISTINCT ON \(credit_media_type, credit_tmdb_id\)/);
        const max = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        assert.equal(max, params.length);
      }
    } finally { c.restore(); }
  }
});

test('listTmdbCreditCandidates: includes verified matches only when tmdb_id is null', async () => {
  const c = capture([]);
  try {
    await listTmdbCreditCandidates(3);
    const { sql, params } = c.calls[0];
    assert.match(sql, /tmdb_id IS NULL AND m\.tmdb_match_status='verified'/);
    assert.equal(Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))), params.length);
  } finally { c.restore(); }
});

import { correctGuessedLookupIds } from '../src/repository.js';

test('correctGuessedLookupIds: touches only guess-fed rows and never tmdb_id', async () => {
  const c = capture([{ canonical_slug: 'a' }, { canonical_slug: 'b' }]);
  try {
    assert.deepEqual(await correctGuessedLookupIds(10), ['a', 'b']);
    const { sql, params } = c.calls[0];
    assert.deepEqual(params, [10]);
    assert.match(sql, /tmdb_id IS NULL AND tmdb_match_status='verified'/);
    assert.match(sql, /tmdb_lookup_id::bigint <> tmdb_match_id/);
    assert.match(sql, /COALESCE\(m\.imdb_id,''\)=''/);
    assert.doesNotMatch(sql, /SET[^']*\btmdb_id=/);
  } finally { c.restore(); }
});
