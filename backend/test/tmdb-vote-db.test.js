import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

let seq = 0;
const BASE_ID = 980000000;

async function setup() {
  const { pool, migrate } = await import('../src/db.js');
  const repo = await import('../src/repository.js');
  await migrate();
  const cleanup = async () => {
    await pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'tmdbvote-%'");
    await pool.query('DELETE FROM tmdb_credits_sync WHERE tmdb_id >= $1', [BASE_ID]);
  };
  await cleanup();
  // ageDays: row age; fetchedDays: age of the credits sync stamp (null = never fetched).
  async function add(name, o = {}) {
    seq += 1;
    const tmdbId = BASE_ID + seq;
    const type = o.type || 'movie';
    await pool.query(
      'INSERT INTO movies (canonical_slug, title, normalized_title, media_type, year, tmdb_id, tmdb_media_type, ' +
      "ratings, created_at) VALUES ($1,$1,$1,$2,2026,$3,$2,$4::jsonb, now() - $5::int * interval '1 day')",
      ['tmdbvote-' + name, type, tmdbId,
        JSON.stringify(o.self ? { tmdb: 7, tmdb_count: 5, tmdb_src: type + ':' + tmdbId } : (o.ratings || {})), o.ageDays ?? 5]
    );
    if (o.fetchedDays !== undefined) {
      await pool.query(
        'INSERT INTO tmdb_credits_sync (media_type, tmdb_id, status, fetched_at) ' +
        "VALUES ($1,$2,$3, now() - $4::numeric * interval '1 day')",
        [type, tmdbId, o.status || 'ok', o.fetchedDays]
      );
    }
    return { slug: 'tmdbvote-' + name, tmdbId, type };
  }
  async function due() {
    const rows = await repo.listTmdbCreditCandidates(100000);
    return new Set(rows.filter((r) => Number(r.tmdb_id) >= BASE_ID).map((r) => Number(r.tmdb_id)));
  }
  const ratingsOf = async (slug) => (await pool.query('SELECT ratings FROM movies WHERE canonical_slug=$1', [slug])).rows[0].ratings;
  return { pool, repo, add, due, cleanup, ratingsOf };
}

dbTest('empty credits retried for new rows only', async () => {
  const { add, due, cleanup } = await setup();
  try {
    const newEmpty = await add('new-empty', { ageDays: 10, status: 'empty', fetchedDays: 8, self: true });
    const newFresh = await add('new-empty-fresh', { ageDays: 10, status: 'empty', fetchedDays: 3, self: true });
    const oldEmpty = await add('old-empty', { ageDays: 200, status: 'empty', fetchedDays: 30 });
    const set = await due();
    assert.ok(set.has(newEmpty.tmdbId), 'new empty >7d is due');
    assert.ok(!set.has(newFresh.tmdbId), 'new empty <7d waits');
    assert.ok(!set.has(oldEmpty.tmdbId), 'old empty keeps the 90d cadence');
  } finally { await cleanup(); }
});

dbTest('new row with null tmdb vote due after 2 days', async () => {
  const { add, due, cleanup } = await setup();
  try {
    const noVote3d = await add('novote-3d', { fetchedDays: 3 });
    const noVote1d = await add('novote-1d', { fetchedDays: 1 });
    const old3d = await add('old-novote', { ageDays: 300, fetchedDays: 3 });
    const providerOnly = await add('provider-vote', { fetchedDays: 3, ratings: { tmdb: 7.4, tmdb_count: 10 } });
    const set = await due();
    assert.ok(set.has(noVote3d.tmdbId));
    assert.ok(!set.has(noVote1d.tmdbId), 'the fetch stamp keeps it out for 2 days');
    assert.ok(!set.has(old3d.tmdbId), 'old rows are not on the fast cadence');
    assert.ok(set.has(providerOnly.tmdbId), 'a provider snapshot (no tmdb_src) is replaced by TMDB own score');
  } finally { await cleanup(); }
});

dbTest('row with real tmdb vote keeps 90d cadence', async () => {
  const { pool, add, due, cleanup } = await setup();
  try {
    const row = await add('selfvote', { fetchedDays: 3 });
    await pool.query('UPDATE movies SET ratings = $2::jsonb WHERE canonical_slug=$1',
      [row.slug, JSON.stringify({ tmdb: 7.4, tmdb_count: 10, tmdb_src: 'movie:' + row.tmdbId })]);
    assert.ok(!(await due()).has(row.tmdbId));
    await pool.query("UPDATE tmdb_credits_sync SET fetched_at = now() - interval '91 days' WHERE tmdb_id=$1", [row.tmdbId]);
    assert.ok((await due()).has(row.tmdbId), 'back after the 90d refresh');
  } finally { await cleanup(); }
});

dbTest('recordTmdbVote returns slug only on change and never writes zero', async () => {
  const { repo, add, cleanup, ratingsOf } = await setup();
  try {
    const row = await add('vote', { fetchedDays: 3 });
    assert.deepEqual(await repo.recordTmdbVote(row.type, row.tmdbId, { average: 0, count: 0 }), []);
    assert.deepEqual(await repo.recordTmdbVote(row.type, row.tmdbId, { average: 8, count: 0 }), []);
    assert.deepEqual(await ratingsOf(row.slug), {}, 'zero vote never written');

    assert.deepEqual(await repo.recordTmdbVote(row.type, row.tmdbId, { average: 7.46, count: 30 }), [row.slug]);
    assert.deepEqual(await ratingsOf(row.slug), { tmdb: 7.5, tmdb_count: 30, tmdb_src: 'movie:' + row.tmdbId });
    // Same rounded score, other vote count: stored and invalidated (the page shows the count).
    assert.deepEqual(await repo.recordTmdbVote(row.type, row.tmdbId, { average: 7.46, count: 45 }), [row.slug]);
    assert.equal((await ratingsOf(row.slug)).tmdb_count, 45);
    // Nothing changed after rounding: no slug.
    assert.deepEqual(await repo.recordTmdbVote(row.type, row.tmdbId, { average: 7.46, count: 45 }), []);
    assert.deepEqual(await repo.recordTmdbVote(row.type, row.tmdbId, { average: 7.9, count: 45 }), [row.slug]);
  } finally { await cleanup(); }
});

dbTest('writeTmdbIdentity: a new id drops the self-fetched score, a season-only change and a provider snapshot keep theirs', async () => {
  const { pool, repo, add, cleanup, ratingsOf } = await setup();
  try {
    const a = await add('wid-a', { type: 'tv', self: true, ratings: { imdb: 7 } });
    const b = await add('wid-b', { ratings: { tmdb: 6, tmdb_count: 3 } });
    const client = await pool.connect();
    try {
      await repo.writeTmdbIdentity(client, (await pool.query('SELECT id FROM movies WHERE canonical_slug=$1', [a.slug])).rows[0].id,
        { id: a.tmdbId, mediaType: 'tv', season: 2 });
      assert.equal((await ratingsOf(a.slug)).tmdb, 7, 'season-only change keeps the score');
      await repo.writeTmdbIdentity(client, (await pool.query('SELECT id FROM movies WHERE canonical_slug=$1', [a.slug])).rows[0].id,
        { id: a.tmdbId + 1000, mediaType: 'tv', season: 2 });
      assert.deepEqual(await ratingsOf(a.slug), {}, 'new id drops the old score');
      await repo.writeTmdbIdentity(client, (await pool.query('SELECT id FROM movies WHERE canonical_slug=$1', [b.slug])).rows[0].id,
        { id: b.tmdbId + 1000, mediaType: 'movie', season: null });
      assert.deepEqual(await ratingsOf(b.slug), { tmdb: 6, tmdb_count: 3 }, 'provider snapshot (no tmdb_src) kept');
    } finally { client.release(); }
  } finally { await cleanup(); }
});

dbTest('recordTmdbVote keeps other rating keys and only touches its identity', async () => {
  const { repo, add, cleanup, ratingsOf } = await setup();
  try {
    const a = await add('keep-a', { ratings: { imdb: 8, imdb_count: 5 } });
    const b = await add('keep-b', { ratings: { imdb: 6 } });
    await repo.recordTmdbVote(a.type, a.tmdbId, { average: 7, count: 3 });
    assert.equal((await ratingsOf(a.slug)).imdb, 8);
    assert.deepEqual(await ratingsOf(b.slug), { imdb: 6 });
  } finally { await cleanup(); }
});

dbTest('recordTmdbCredits returns slugs only when the cast really changed', async () => {
  const { pool, repo, add, cleanup } = await setup();
  try {
    const row = await add('credits', {});
    const payload = { status: 'ok', cast: [{ tmdbPersonId: 990000001, name: 'Tmdbvote Actor', profileSourceUrl: null, characterName: 'X', order: 0 }], directors: [] };
    assert.deepEqual(await repo.recordTmdbCredits(row.type, row.tmdbId, payload), [row.slug]);
    assert.deepEqual(await repo.recordTmdbCredits(row.type, row.tmdbId, payload), [], 'identical refetch changes nothing');
    assert.deepEqual(await repo.recordTmdbCredits(row.type, row.tmdbId, { status: 'ok', cast: [], directors: [] }), [row.slug]);
    await pool.query('DELETE FROM people WHERE tmdb_person_id=990000001');
  } finally { await cleanup(); }
});

dbTest('duplicate merge: null scores on the dropped row never clear the survivor', async () => {
  const { pool, cleanup } = await setup();
  const { upsertCanonical } = await import('../src/repository.js');
  const { mergeDuplicate } = await import('../src/duplicateMergeRepository.js');
  const incoming = (provider, slug) => ({
    provider, providerMovieId: provider + '-' + slug, providerSlug: slug, priority: provider === 'nguonc' ? 10 : 20,
    title: 'Tmdbvote ' + slug, originalTitle: null, normalizedTitle: 'tmdbvote ' + slug, normalizedOriginalTitle: null,
    mediaType: 'movie', displayType: 'single', year: 2020, tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null,
    imdbId: null, overview: null, thumbSourceUrl: null, posterSourceUrl: null, quality: null, language: null,
    status: null, episodeCurrent: null, episodeTotal: null, duration: null, actors: [], directors: [], genres: [],
    countries: [], ratings: {}, metadata: {}, streams: [], providerUpdatedAt: null
  });
  try {
    const keep = (await upsertCanonical(incoming('kkphim', 'tmdbvote-dm-kk'))).movie;
    const drop = (await upsertCanonical(incoming('nguonc', 'tmdbvote-dm-nc'))).movie;
    await pool.query('UPDATE movies SET ratings=$2::jsonb WHERE id=$1', [keep.id, JSON.stringify({ imdb: 8, imdb_count: 40 })]);
    await pool.query('UPDATE movies SET ratings=$2::jsonb WHERE id=$1', [drop.id, JSON.stringify({ imdb: null, tmdb: 6.5, tmdb_count: 3 })]);
    const result = await mergeDuplicate(keep.id, drop.id);
    assert.equal(result.merged, true);
    const { rows: [row] } = await pool.query('SELECT ratings FROM movies WHERE id=$1', [keep.id]);
    assert.deepEqual(row.ratings, { imdb: 8, imdb_count: 40, tmdb: 6.5, tmdb_count: 3 });
  } finally {
    await pool.query("DELETE FROM movie_merges WHERE kept_slug LIKE 'tmdbvote-%'");
    await pool.query("DELETE FROM movie_slug_aliases WHERE slug LIKE 'tmdbvote-%'");
    await cleanup();
  }
});
