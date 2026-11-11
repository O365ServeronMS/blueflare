import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

dbTest('provider identity SQL: claims refresh, row listing, review upsert, imdb fill, overwrite count', async () => {
  const { pool, migrate } = await import('../src/db.js');
  const sync = await import('../src/providerIdentitySync.js');
  await migrate();
  const clean = () => pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'pid-%'");
  await clean();
  const movie = async (slug, extra = '') => (await pool.query(
    "INSERT INTO movies (canonical_slug, title, normalized_title, year, media_type, display_type, catalog_state" + (extra ? ', imdb_id' : '') + ') ' +
    "VALUES ($1, $1, $1, 2020, 'movie', 'single', 'ready'" + (extra ? ', $2' : '') + ') RETURNING id', extra ? [slug, extra] : [slug]
  )).rows[0].id;
  const a = await movie('pid-a');
  const b = await movie('pid-b', 'tt7777777');
  await pool.query(
    "INSERT INTO movie_provider_sources (movie_id, provider, provider_movie_id, provider_slug, priority, metadata, updated_at) VALUES " +
    "($1, 'nguonc', 'pid-a-nc', 'pid-a-nc', 1, '{\"title\":\"A\",\"tmdb_id\":1}'::jsonb, now() - interval '9 days'), " +
    "($1, 'kkphim', 'pid-a-kk', 'pid-a-kk', 2, '{\"title\":\"A\",\"tmdb_id\":10,\"tmdb_type\":\"movie\"}'::jsonb, now() - interval '9 days')",
    [a]
  );

  // Claims: identity keys replaced, other keys and updated_at kept, an unchanged record not rewritten.
  const changed = await sync.updateSourceIdentityClaims('nguonc', [{ slug: 'pid-a-nc', meta: { tmdb_id: 10, tmdb_type: 'movie', imdb_id: 'tt1234567' } }]);
  assert.equal(changed, 1);
  assert.equal(await sync.updateSourceIdentityClaims('nguonc', [{ slug: 'pid-a-nc', meta: { tmdb_id: 10, tmdb_type: 'movie', imdb_id: 'tt1234567' } }]), 0);
  const source = (await pool.query("SELECT metadata, updated_at < now() - interval '1 day' AS old FROM movie_provider_sources WHERE provider_slug='pid-a-nc'")).rows[0];
  assert.deepEqual(source.metadata, { title: 'A', tmdb_id: 10, tmdb_type: 'movie', imdb_id: 'tt1234567' });
  assert.equal(source.old, true);

  // Listing carries every available source's claim.
  const rows = (await sync.listProviderIdentityRows(1000)).filter((row) => row.canonical_slug.startsWith('pid-'));
  const rowA = rows.find((row) => row.id === a);
  assert.equal(rowA.provider_claims.length, 2);
  assert.equal(rowA.review_key, null);

  // Review upsert: a second decision replaces the first; done gets resolved_at.
  await sync.saveProviderReview({ movieId: a, key: 'k1', action: 'queue', reason: 'providers-disagree', status: 'pending', candidates: [{ id: 1, type: 'movie' }] });
  await sync.saveProviderReview({ movieId: a, key: 'k2', action: 'assign', reason: 'providers-agree', tier: 'fill', status: 'done', outcome: 'assigned' });
  const review = (await pool.query('SELECT * FROM provider_identity_reviews WHERE movie_id=$1', [a])).rows[0];
  assert.deepEqual([review.claims_key, review.status, review.resolved_at !== null], ['k2', 'done', true]);
  const listed = (await sync.listProviderIdentityRows(1000)).find((row) => row.id === a);
  assert.deepEqual([listed.review_key, listed.review_status], ['k2', 'done']);

  // imdb: filled when free, refused when another season-less row of the family holds it.
  assert.equal(await sync.fillImdbId({ id: a }, 'tt7777777'), false);
  assert.equal(await sync.fillImdbId({ id: a }, 'tt1234567'), true);
  assert.equal(await sync.fillImdbId({ id: a }, 'tt2222222'), false, 'never overwrites');

  // Overwrite count: only provider season/overwrite writes of this pass, today.
  const log = (tier, source = 'provider') => pool.query(
    "INSERT INTO tmdb_identity_changes (movie_id, kind, source, tmdb_id, media_type, evidence) VALUES ($1, 'assign', $2, 10, 'movie', $3::jsonb)",
    [b, source, JSON.stringify({ pass: 'provider-ids', tier })]
  );
  const before = await sync.countProviderOverwritesToday();
  await log('overwrite');
  await log('season');
  await log('fill');
  await log('overwrite', 'inferred');
  assert.equal(await sync.countProviderOverwritesToday(), before + 2);

  await pool.query('DELETE FROM tmdb_identity_changes WHERE movie_id=$1', [b]);
  await clean();
  await pool.end();
});
