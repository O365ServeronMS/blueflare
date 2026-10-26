import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

// Production case 2026-10-24 (sat-thu-dai-chien -> sat-thu-gia-vo, NguonC id d7416380...):
// NguonC renamed the slug of a film it already served, keeping the same movie.id.
const REAL_ID = 'bhrename0000000000000000000000ff';
const OLD_SLUG = 'bhrename-sat-thu-dai-chien';
const NEW_SLUG = 'bhrename-sat-thu-gia-vo';

const category = {
  1: { group: { name: 'Định dạng' }, list: [{ name: 'Phim lẻ' }] },
  3: { group: { name: 'Năm' }, list: [{ name: '2023' }] }
};
const episodes = [{ server_name: 'Vietsub #1', items: [{ name: 'Full', slug: 'tap-full', embed: 'https://embed.example/e' }] }];

// /api/film/<slug> payload: carries movie.id.
const detail = (slug, name) => ({
  movie: {
    id: REAL_ID, slug, name, original_name: 'Hit Man', year: 2023,
    modified: '2026-10-24T03:44:11.000000Z', category, episodes
  }
});
// /api/films/phim-moi-cap-nhat item: NguonC list items have no `id` field at all.
const listItem = (slug, name) => ({
  slug, name, original_name: 'Hit Man', year: 2023, modified: '2026-10-24T03:44:11.000000Z'
});

async function setup() {
  const { pool, migrate } = await import('../src/db.js');
  const { upsertCanonical } = await import('../src/repository.js');
  const { normalizeNguonc } = await import('../src/normalize.js');
  await migrate();
  const cleanup = () => pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'bhrename-%'");
  await cleanup();
  const sources = async () => (await pool.query(
    "SELECT provider_movie_id, provider_slug FROM movie_provider_sources WHERE provider='nguonc' " +
    "AND provider_slug LIKE 'bhrename-%' ORDER BY provider_slug"
  )).rows;
  return { pool, upsertCanonical, normalizeNguonc, cleanup, sources };
}

dbTest('nguonc slug rename: detail of the new slug after a summary fallback upserts instead of hitting UNIQUE (provider, provider_movie_id)', async () => {
  const { pool, upsertCanonical, normalizeNguonc, cleanup, sources } = await setup();
  try {
    // 1. Known for months under the old slug, with the real id.
    await upsertCanonical(normalizeNguonc(detail(OLD_SLUG, 'Sát Thủ Đại Chiến')));
    // 2. Renamed. /api/film/<new> answers 404 for a while, so worker.syncPage falls back to
    //    the list item (summaryFallback). No id in the item -> providerMovieId = slug.
    await upsertCanonical(normalizeNguonc({ movie: listItem(NEW_SLUG, 'Sát Thủ Giả Vờ') }));
    assert.deepEqual(await sources(), [
      { provider_movie_id: REAL_ID, provider_slug: OLD_SLUG },
      { provider_movie_id: NEW_SLUG, provider_slug: NEW_SLUG }
    ], 'precondition: the summary fallback created a second nguonc row for the same work');

    // 3. /api/film/<new> starts answering with the real id. In production this threw
    //    'duplicate key value violates unique constraint
    //    "movie_provider_sources_provider_provider_movie_id_key"' every cycle.
    const summaryMovie = (await pool.query(
      "SELECT m.id, m.canonical_slug FROM movies m JOIN movie_provider_sources s ON s.movie_id=m.id WHERE s.provider='nguonc' AND s.provider_slug=$1",
      [NEW_SLUG]
    )).rows[0];
    let result;
    await assert.doesNotReject(
      (async () => { result = await upsertCanonical(normalizeNguonc(detail(NEW_SLUG, 'Sát Thủ Giả Vờ'))); })(),
      'detail upsert of a renamed slug must succeed'
    );
    assert.deepEqual(await sources(), [
      { provider_movie_id: REAL_ID, provider_slug: NEW_SLUG }
    ], 'one nguonc row per provider id, under the new slug');
    // the real row keeps its movie; the summary's now source-less movie is hidden, not deleted
    assert.equal(result.movie.canonical_slug, OLD_SLUG);
    assert.deepEqual(result.hiddenSlugs, [summaryMovie.canonical_slug]);
    const hidden = (await pool.query('SELECT catalog_state FROM movies WHERE id=$1', [summaryMovie.id])).rows[0];
    assert.equal(hidden.catalog_state, 'unavailable');
  } finally {
    await cleanup();
  }
});

dbTest('nguonc slug rename without a summary fallback in between is a plain update (control)', async () => {
  const { upsertCanonical, normalizeNguonc, cleanup, sources } = await setup();
  try {
    await upsertCanonical(normalizeNguonc(detail(OLD_SLUG, 'Sát Thủ Đại Chiến')));
    await upsertCanonical(normalizeNguonc(detail(NEW_SLUG, 'Sát Thủ Giả Vờ')));
    assert.deepEqual(await sources(), [
      { provider_movie_id: REAL_ID, provider_slug: NEW_SLUG }
    ]);
  } finally {
    await cleanup();
  }
});

dbTest('nguonc: list item (summary fallback) never carries a real provider id', async () => {
  const { pool } = await import('../src/db.js');
  const { normalizeNguonc } = await import('../src/normalize.js');
  const summary = normalizeNguonc({ movie: listItem(NEW_SLUG, 'Sát Thủ Giả Vờ') });
  assert.equal(summary.providerMovieId, NEW_SLUG);
  assert.equal(summary.streams.length, 0);
  await pool.end();
});
