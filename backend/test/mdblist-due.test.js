import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

const DAY = 86400000;
const YEAR = new Date().getUTCFullYear();
let seq = 0;

async function setup() {
  const { pool, migrate } = await import('../src/db.js');
  const { listMdblistBackfillCandidates } = await import('../src/repository.js');
  await migrate();
  const cleanup = () => pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'mdbdue-%'");
  await cleanup();
  // Inserts one row; `ageDays`/`checkedDays` are how long ago created / last checked.
  async function add(name, o = {}) {
    seq += 1;
    const slug = 'mdbdue-' + name;
    await pool.query(
      'INSERT INTO movies (canonical_slug, title, normalized_title, media_type, year, tmdb_id, tmdb_media_type, ' +
      'imdb_id, tmdb_lookup_id, created_at, catalog_sort_at, mdblist_status, mdblist_checked_at, ' +
      'mdblist_tomatoes, mdblist_audience) VALUES ($1,$1,$1,$2,$3,$4,$5,$6,$7,' +
      "now() - $8::int * interval '1 day', $9, $10, " +
      "CASE WHEN $11::numeric IS NULL THEN NULL ELSE now() - $11::numeric * interval '1 day' END, $12, $13)",
      [
        slug, o.mediaType || 'movie', 'year' in o ? o.year : YEAR, o.tmdbId ?? null, o.tmdbType ?? null,
        o.imdb ?? null, o.lookup ?? null, o.ageDays ?? 5, o.sortAt ?? null, o.status || 'unmatched',
        o.checkedDays ?? null, o.tomatoes ?? null, o.audience ?? null
      ]
    );
    return slug;
  }
  async function due() {
    const rows = await listMdblistBackfillCandidates('', 100000);
    return new Set(rows.map((row) => row.canonical_slug));
  }
  // Every row needs some id to be walked by the backfill.
  return { pool, add, due, cleanup, id: () => 900000000 + seq * 7 };
}

dbTest('fresh unmatched retries 2d/7d/14d', async () => {
  const { add, due, cleanup, id } = await setup();
  try {
    const slugs = {
      freshNot: await add('fresh-not', { ageDays: 5, checkedDays: 1, lookup: id() }),
      freshDue: await add('fresh-due', { ageDays: 5, checkedDays: 3, lookup: id() }),
      midNot: await add('mid-not', { ageDays: 30, checkedDays: 5, lookup: id() }),
      midDue: await add('mid-due', { ageDays: 30, checkedDays: 8, lookup: id() }),
      newNot: await add('new-not', { ageDays: 60, checkedDays: 10, lookup: id() }),
      newDue: await add('new-due', { ageDays: 60, checkedDays: 15, lookup: id() }),
      beyond: await add('beyond', { ageDays: 120, checkedDays: 20, lookup: id() }),
      beyondDue: await add('beyond-due', { ageDays: 120, checkedDays: 91, lookup: id() })
    };
    const result = await due();
    for (const key of ['freshDue', 'midDue', 'newDue', 'beyondDue']) assert.ok(result.has(slugs[key]), key);
    for (const key of ['freshNot', 'midNot', 'newNot', 'beyond']) assert.ok(!result.has(slugs[key]), key);
  } finally { await cleanup(); }
});

dbTest('old-year row with recent catalog_sort_at is not new', async () => {
  const { add, due, cleanup, id } = await setup();
  try {
    const old = await add('old-year', { ageDays: 5, year: YEAR - 5, sortAt: new Date(), checkedDays: 3, lookup: id() });
    assert.ok(!(await due()).has(old));
  } finally { await cleanup(); }
});

dbTest('no-id due only with valid id', async () => {
  const { add, due, cleanup, id } = await setup();
  try {
    const opts = { status: 'no-id', ageDays: 200, year: 2000, checkedDays: 1 / 24 };
    const tmdb = await add('noid-tmdb', { ...opts, tmdbId: id(), tmdbType: 'movie' });
    const imdb = await add('noid-imdb', { ...opts, imdb: 'tt1234567' });
    const lookup = await add('noid-lookup', { ...opts, lookup: id() });
    const badImdb = await add('noid-badimdb', { ...opts, imdb: 'tt12' });
    const result = await due();
    assert.ok(result.has(tmdb) && result.has(imdb) && result.has(lookup));
    assert.ok(!result.has(badImdb), 'a malformed imdb id is not a valid id');
  } finally { await cleanup(); }
});

dbTest('no-id without id keeps old cadence', async () => {
  const { add, due, cleanup } = await setup();
  try {
    const recent = await add('noid-none-recent', { status: 'no-id', ageDays: 200, checkedDays: 1 });
    const stale = await add('noid-none-stale', { status: 'no-id', ageDays: 200, checkedDays: 91 });
    const result = await due();
    assert.ok(!result.has(recent));
    // Without any id the backfill walk never lists the row (it requires an id column), so the
    // cadence is checked on the shared predicate directly.
    const { pool } = await import('../src/db.js');
    const { MDBLIST_DUE_SQL, mdblistDueParams } = await import('../src/repository.js');
    const direct = await pool.query(
      "SELECT canonical_slug FROM movies WHERE canonical_slug LIKE 'mdbdue-noid-none-%' AND $1::text IS NOT NULL AND $5::int > 0 AND " + MDBLIST_DUE_SQL,
      ['', ...mdblistDueParams(1)]
    );
    assert.deepEqual(direct.rows.map((r) => r.canonical_slug), [stale]);
  } finally { await cleanup(); }
});

dbTest('null year not fresh', async () => {
  const { add, due, cleanup, id } = await setup();
  try {
    const row = await add('null-year', { year: null, ageDays: 5, checkedDays: 3, lookup: id() });
    assert.ok(!(await due()).has(row));
  } finally { await cleanup(); }
});

dbTest('matched missing one score follows age cadence', async () => {
  const { add, due, cleanup, id } = await setup();
  try {
    const missingDue = await add('m-miss-due', { status: 'matched', ageDays: 5, checkedDays: 3, tomatoes: 80, lookup: id() });
    const missingNot = await add('m-miss-not', { status: 'matched', ageDays: 5, checkedDays: 1, audience: 70, lookup: id() });
    const full = await add('m-full', { status: 'matched', ageDays: 5, year: YEAR - 5, checkedDays: 3, tomatoes: 80, audience: 70, lookup: id() });
    const result = await due();
    assert.ok(result.has(missingDue));
    assert.ok(!result.has(missingNot));
    assert.ok(!result.has(full), 'a fully scored row keeps its normal cadence');
  } finally { await cleanup(); }
});

dbTest('migration 038 resets only the tv-typed set', async () => {
  const { pool, add, cleanup, id } = await setup();
  try {
    const stamp = { status: 'matched', checkedDays: 3, tomatoes: 80, audience: 70 };
    const hit = await add('mig-hit', { ...stamp, mediaType: 'movie', tmdbId: id(), tmdbType: 'tv' });
    const movie = await add('mig-movie', { ...stamp, mediaType: 'movie', tmdbId: id(), tmdbType: 'movie' });
    const tv = await add('mig-tv', { ...stamp, mediaType: 'tv', tmdbId: id(), tmdbType: 'tv' });
    const noId = await add('mig-noid', { ...stamp, mediaType: 'movie', tmdbType: 'tv', lookup: id() });
    const sql = await readFile(new URL('../migrations/038_mdblist_recheck_tv_typed.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    await pool.query(sql); // idempotent
    const rows = (await pool.query(
      "SELECT canonical_slug, mdblist_checked_at, mdblist_tomatoes, mdblist_audience FROM movies WHERE canonical_slug LIKE 'mdbdue-mig-%'"
    )).rows;
    const by = Object.fromEntries(rows.map((r) => [r.canonical_slug, r]));
    assert.equal(by[hit].mdblist_checked_at, null);
    assert.equal(by[hit].mdblist_tomatoes, 80, 'scores stay so changedScore can compare');
    assert.equal(by[hit].mdblist_audience, 70);
    for (const slug of [movie, tv, noId]) assert.notEqual(by[slug].mdblist_checked_at, null, slug);
  } finally { await cleanup(); }
});
