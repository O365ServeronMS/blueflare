import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

const incoming = (slug) => ({
  provider: 'kkphim', providerMovieId: 'id-' + slug, providerSlug: slug,
  priority: 20, title: 'Stale lane ' + slug, originalTitle: null, normalizedTitle: 'stale lane ' + slug,
  normalizedOriginalTitle: null, mediaType: 'movie', displayType: 'single', year: 2020,
  tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null, imdbId: null,
  overview: null, thumbSourceUrl: null, posterSourceUrl: null, quality: null, language: null,
  status: null, episodeCurrent: null, episodeTotal: null, duration: null, actors: [], directors: [],
  genres: [], countries: [], ratings: {}, metadata: {}, streams: [], providerUpdatedAt: null
});

dbTest('stale lane: defer hides a source, upsert resets it', async () => {
  const { pool, migrate } = await import('../src/db.js');
  const { upsertCanonical, listStaleSources, deferStaleSource, countDeferredStale } = await import('../src/repository.js');
  await migrate();
  const cleanup = () => pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'stalelane-%'");
  await cleanup();
  try {
    await upsertCanonical(incoming('stalelane-a'));
    const { rows: [src] } = await pool.query("SELECT id FROM movie_provider_sources WHERE provider_slug='stalelane-a'");
    await pool.query("UPDATE movie_provider_sources SET last_success_at = now() - interval '30 days' WHERE id=$1", [src.id]);
    const day = 24 * 60 * 60 * 1000;
    const mine = async () => (await listStaleSources(['kkphim'], 14 * day, 1000)).filter((r) => r.provider_slug === 'stalelane-a');
    const deferred = () => countDeferredStale(['kkphim'], 14 * day);

    assert.equal((await mine()).length, 1);
    assert.equal(await deferred(), 0);

    await deferStaleSource(src.id, 3600000);
    assert.equal((await mine()).length, 0, 'a deferred source is not listed');
    assert.equal(await deferred(), 1);

    await deferStaleSource(src.id, 0);
    assert.equal((await mine()).length, 1, 'a due source is listed again');
    assert.equal(await deferred(), 0);

    await deferStaleSource(src.id, 3600000);
    await upsertCanonical(incoming('stalelane-a'));
    const { rows: [after] } = await pool.query(
      'SELECT stale_next_check_at, last_success_at > now() - interval \'1 minute\' AS fresh FROM movie_provider_sources WHERE id=$1', [src.id]);
    assert.equal(after.stale_next_check_at, null, 'upsertCanonical clears the schedule');
    assert.equal(after.fresh, true);
  } finally {
    await cleanup();
  }
});

dbTest('stale lane: a movie is deleted only once no available source is left, with its user rows', async () => {
  const { pool, migrate } = await import('../src/db.js');
  const { upsertCanonical, markSourceUnavailable, deleteMovieIfNoAvailableSource } = await import('../src/repository.js');
  await migrate();
  const cleanup = async () => {
    await pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'stalelane-%'");
    await pool.query("DELETE FROM users WHERE email = 'stalelane@test.invalid'");
  };
  await cleanup();
  try {
    const { movie } = await upsertCanonical(incoming('stalelane-del'));
    const { rows: [src] } = await pool.query("SELECT id FROM movie_provider_sources WHERE provider_slug='stalelane-del'");
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('stalelane@test.invalid', 'x') RETURNING id");
    await pool.query('INSERT INTO user_favorites (user_id, movie_id) VALUES ($1, $2)', [user.id, movie.id]);
    await pool.query('INSERT INTO user_history (user_id, movie_id) VALUES ($1, $2)', [user.id, movie.id]);

    assert.equal(await deleteMovieIfNoAvailableSource(movie.id), null, 'an available source keeps the movie');
    assert.equal((await pool.query('SELECT 1 FROM movies WHERE id=$1', [movie.id])).rowCount, 1);

    assert.ok(await markSourceUnavailable(src.id));
    assert.equal(await deleteMovieIfNoAvailableSource(movie.id), movie.canonical_slug);
    assert.equal((await pool.query('SELECT 1 FROM movies WHERE id=$1', [movie.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM movie_provider_sources WHERE id=$1', [src.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM user_favorites WHERE movie_id=$1', [movie.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM user_history WHERE movie_id=$1', [movie.id])).rowCount, 0);
    assert.equal(await deleteMovieIfNoAvailableSource(movie.id), null, 'a second call is a no-op');
  } finally {
    await cleanup();
    await pool.end();
  }
});
