import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

const incoming = (provider, slug) => ({
  provider, providerMovieId: provider + '-' + slug, providerSlug: slug,
  priority: provider === 'nguonc' ? 10 : 20, title: 'Dupmerge ' + slug, originalTitle: null,
  normalizedTitle: 'dupmerge ' + slug, normalizedOriginalTitle: null, mediaType: 'movie', displayType: 'single',
  year: 2020, tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null, imdbId: null,
  overview: null, thumbSourceUrl: null, posterSourceUrl: null, quality: null, language: null,
  status: null, episodeCurrent: null, episodeTotal: null, duration: null, actors: [], directors: [],
  genres: [], countries: [], ratings: {}, metadata: {}, streams: [], providerUpdatedAt: null
});

async function setup() {
  const { pool, migrate } = await import('../src/db.js');
  const { upsertCanonical, findMovieIdBySlug } = await import('../src/repository.js');
  const { mergeDuplicate } = await import('../src/duplicateMergeRepository.js');
  await migrate();
  const cleanup = async () => {
    await pool.query("DELETE FROM movie_merges WHERE kept_slug LIKE 'dupmerge-%'");
    await pool.query("DELETE FROM movie_slug_aliases WHERE slug LIKE 'dupmerge-%'");
    await pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'dupmerge-%'");
    await pool.query("DELETE FROM users WHERE email = 'dupmerge@test.invalid'");
  };
  await cleanup();
  const pair = async (name) => ({
    keep: (await upsertCanonical(incoming('kkphim', 'dupmerge-' + name + '-kk'))).movie,
    drop: (await upsertCanonical(incoming('nguonc', 'dupmerge-' + name + '-nc'))).movie
  });
  return { pool, findMovieIdBySlug, mergeDuplicate, cleanup, pair };
}

dbTest('duplicate merge: folds the NguonC row into the KKPhim row with its sources, user rows and slug', async () => {
  const { pool, findMovieIdBySlug, mergeDuplicate, cleanup, pair } = await setup();
  try {
    const { keep, drop } = await pair('a');
    assert.notEqual(keep.id, drop.id);
    // A canonical slug no source carries: only the alias can keep it resolving after the merge.
    drop.canonical_slug = 'dupmerge-a-canonical';
    await pool.query('UPDATE movies SET canonical_slug=$2 WHERE id=$1', [drop.id, drop.canonical_slug]);
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('dupmerge@test.invalid', 'x') RETURNING id");
    await pool.query('INSERT INTO user_favorites (user_id, movie_id) VALUES ($1,$2)', [user.id, drop.id]);
    // Both rows were watched: the newer entry (on the dropped row) wins.
    await pool.query("INSERT INTO user_history (user_id, movie_id, watched_at, episode_key) VALUES ($1,$2, now() - interval '2 days', 'old')", [user.id, keep.id]);
    await pool.query("INSERT INTO user_history (user_id, movie_id, watched_at, episode_key) VALUES ($1,$2, now(), 'new')", [user.id, drop.id]);

    const result = await mergeDuplicate(keep.id, drop.id);
    assert.deepEqual(result, { merged: true, keptSlug: keep.canonical_slug, droppedSlug: drop.canonical_slug, previousSlug: keep.canonical_slug });

    assert.equal((await pool.query('SELECT 1 FROM movies WHERE id=$1', [drop.id])).rowCount, 0);
    const { rows: sources } = await pool.query('SELECT provider FROM movie_provider_sources WHERE movie_id=$1 ORDER BY provider', [keep.id]);
    assert.deepEqual(sources.map((s) => s.provider), ['kkphim', 'nguonc']);
    assert.equal(await findMovieIdBySlug(drop.canonical_slug), keep.id, 'the dropped slug resolves to the survivor');
    assert.equal((await pool.query('SELECT movie_id FROM movie_slug_aliases WHERE slug=$1', [drop.canonical_slug])).rows[0]?.movie_id, keep.id);
    assert.equal((await pool.query('SELECT 1 FROM user_favorites WHERE user_id=$1 AND movie_id=$2', [user.id, keep.id])).rowCount, 1);
    const { rows: history } = await pool.query('SELECT movie_id, episode_key FROM user_history WHERE user_id=$1', [user.id]);
    assert.deepEqual(history, [{ movie_id: keep.id, episode_key: 'new' }]);

    const { rows: [snapshot] } = await pool.query('SELECT dropped_row, favorites, history, moved_source_ids FROM movie_merges WHERE dropped_movie_id=$1', [drop.id]);
    assert.equal(snapshot.dropped_row.canonical_slug, drop.canonical_slug, 'the undo snapshot keeps the dropped row');
    assert.equal(snapshot.favorites.length, 1);
    assert.equal(snapshot.history[0].episode_key, 'new');
    assert.equal(snapshot.moved_source_ids.length, 1);

    assert.deepEqual(await mergeDuplicate(keep.id, drop.id), { merged: false, reason: 'row-missing' }, 'a replay is refused');
  } finally {
    await cleanup();
  }
});

dbTest('duplicate merge: refuses rows whose providers changed since planning, writing nothing', async () => {
  const { pool, mergeDuplicate, cleanup, pair } = await setup();
  try {
    const { keep, drop } = await pair('b');
    // Swapped ids: the "keep" row is the NguonC one.
    assert.deepEqual(await mergeDuplicate(drop.id, keep.id), { merged: false, reason: 'providers-changed' });
    await pool.query("UPDATE movies SET catalog_state='unavailable' WHERE id=$1", [drop.id]);
    assert.deepEqual(await mergeDuplicate(keep.id, drop.id), { merged: false, reason: 'row-missing' });
    assert.equal((await pool.query('SELECT 1 FROM movies WHERE id = ANY($1::uuid[])', [[keep.id, drop.id]])).rowCount, 2);
    assert.equal((await pool.query('SELECT 1 FROM movie_merges WHERE dropped_movie_id = ANY($1::uuid[])', [[keep.id, drop.id]])).rowCount, 0);
  } finally {
    await cleanup();
  }
});

dbTest('duplicate merge: renameTo gives the survivor a new slug and does not alias the stale one', async () => {
  const { pool, findMovieIdBySlug, mergeDuplicate, cleanup, pair } = await setup();
  try {
    const { keep, drop } = await pair('c');
    await pool.query('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2)', ['dupmerge-c-renamed', drop.id]);
    const result = await mergeDuplicate(keep.id, drop.id, 'dupmerge-c-renamed');
    assert.equal(result.keptSlug, 'dupmerge-c-renamed');
    assert.equal(result.previousSlug, keep.canonical_slug);
    assert.equal((await pool.query('SELECT canonical_slug FROM movies WHERE id=$1', [keep.id])).rows[0].canonical_slug, 'dupmerge-c-renamed');
    assert.equal((await pool.query('SELECT 1 FROM movie_slug_aliases WHERE slug=$1', ['dupmerge-c-renamed'])).rowCount, 0,
      'an alias equal to the new canonical slug is removed');
    assert.equal((await pool.query('SELECT 1 FROM movie_slug_aliases WHERE slug=$1', [keep.canonical_slug])).rowCount, 0,
      'the old season slug is not kept as an alias');
    assert.equal(await findMovieIdBySlug(drop.canonical_slug), keep.id);
  } finally {
    await cleanup();
    await pool.end();
  }
});
