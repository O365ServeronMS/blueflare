import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;
test.after(async () => { if (TEST_DB) await (await import('../src/db.js')).pool.end(); });

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
  // A list item without a season keeps the stored season of the same id; another id drops it.
  await sync.updateSourceIdentityClaims('nguonc', [{ slug: 'pid-a-nc', meta: { tmdb_id: 10, tmdb_type: 'movie', tmdb_season: 2, imdb_id: 'tt1234567' } }]);
  assert.equal(await sync.updateSourceIdentityClaims('nguonc', [{ slug: 'pid-a-nc', meta: { tmdb_id: 10, tmdb_type: 'movie', imdb_id: 'tt1234567' } }]), 0);
  await sync.updateSourceIdentityClaims('nguonc', [{ slug: 'pid-a-nc', meta: { tmdb_id: 11, tmdb_type: 'movie', imdb_id: 'tt1234567' } }]);
  assert.equal((await pool.query("SELECT metadata->'tmdb_season' AS s FROM movie_provider_sources WHERE provider_slug='pid-a-nc'")).rows[0].s, null);
  await sync.updateSourceIdentityClaims('nguonc', [{ slug: 'pid-a-nc', meta: { tmdb_id: 10, tmdb_type: 'movie', imdb_id: 'tt1234567' } }]);

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
  // decided_at stays when only the fingerprint changes; moves when the decision changes.
  const decidedAt = async () => (await pool.query('SELECT decided_at FROM provider_identity_reviews WHERE movie_id=$1', [a])).rows[0].decided_at.getTime();
  await pool.query("UPDATE provider_identity_reviews SET decided_at = now() - interval '1 hour' WHERE movie_id=$1", [a]);
  const hourAgo = await decidedAt();
  await sync.saveProviderReview({ movieId: a, key: 'k3', action: 'assign', reason: 'providers-agree', tier: 'fill', status: 'done', outcome: 'assigned' });
  assert.equal(await decidedAt(), hourAgo);
  await sync.saveProviderReview({ movieId: a, key: 'k2', action: 'assign', reason: 'providers-agree', tier: 'fill', status: 'done', outcome: 'assigned' });
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
  await pool.query(
    "INSERT INTO tmdb_identity_changes (movie_id, kind, source, tmdb_id, media_type, evidence) VALUES ($1, 'merge', 'provider', 10, 'movie', $2::jsonb)",
    [b, JSON.stringify({ pass: 'provider-ids', tier: 'fill' })]
  );
  assert.equal(await sync.countProviderOverwritesToday(), before + 3, 'a merge counts whatever its tier');

  await pool.query('DELETE FROM tmdb_identity_changes WHERE movie_id=$1', [b]);
  await clean();
});

dbTest('AI match review listing and resolution on a real database', async () => {
  const { pool, migrate } = await import('../src/db.js');
  const ai = await import('../src/tmdbMatchAiSync.js');
  await migrate();
  const clean = () => pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'pidr-%'");
  await clean();
  const movie = async (slug) => (await pool.query(
    "INSERT INTO movies (canonical_slug, title, normalized_title, year, media_type, display_type, catalog_state) " +
    "VALUES ($1, $1, $1, 2020, 'movie', 'single', 'ready') RETURNING id", [slug])).rows[0].id;
  const a = await movie('pidr-a');
  const b = await movie('pidr-b');
  const c = await movie('pidr-c');
  const review = (id, reason) => pool.query(
    "INSERT INTO provider_identity_reviews (movie_id, claims_key, action, reason, status, candidates, decided_at) " +
    "VALUES ($1, 'k', 'queue', $2, 'pending', '[{\"id\":77,\"type\":\"movie\"}]'::jsonb, now() - interval '1 hour')", [id, reason]);
  await review(a, 'providers-disagree');
  await review(b, 'single-vs-existing');
  await review(c, 'season-disagree'); // a season question goes to the catalog audit, never to the AI
  const ours = async (mode) => (await ai.listProviderReviewCandidates({ mode, limit: 100, errorRetryMs: 3600000 }))
    .filter((row) => row.canonical_slug.startsWith('pidr-'));
  let listed = await ours('apply');
  assert.deepEqual(listed.map((row) => row.canonical_slug).sort(), ['pidr-a', 'pidr-b']);
  assert.deepEqual(listed.find((row) => row.id === a).review_candidates, [{ id: 77, type: 'movie' }]);

  // A run after decided_at settles it; a dry-run verified run does not count in apply mode.
  const run = (id, mode, outcome) => pool.query(
    "INSERT INTO tmdb_match_ai_runs (run_id, mode, movie_id, status, outcome) VALUES (gen_random_uuid(), $2, $1, 'skipped', $3)", [id, mode, outcome]);
  await run(a, 'dry-run', 'verified');
  assert.deepEqual((await ours('apply')).map((row) => row.canonical_slug).sort(), ['pidr-a', 'pidr-b']);
  assert.deepEqual((await ours('dry-run')).map((row) => row.canonical_slug), ['pidr-b']);
  await run(b, 'apply', 'none');
  assert.deepEqual((await ours('apply')).map((row) => row.canonical_slug), ['pidr-a']);

  // Resolution: dry-run only notes the outcome, apply closes the review.
  await ai.resolveProviderReview(a, 'ai-assigned', { mode: 'dry-run' });
  let row = (await pool.query('SELECT status, outcome, resolved_at FROM provider_identity_reviews WHERE movie_id=$1', [a])).rows[0];
  assert.deepEqual([row.status, row.outcome, row.resolved_at], ['pending', 'ai-assigned', null]);
  await ai.resolveProviderReview(a, 'ai-confirmed', { mode: 'apply' });
  row = (await pool.query('SELECT status, outcome, resolved_at FROM provider_identity_reviews WHERE movie_id=$1', [a])).rows[0];
  assert.deepEqual([row.status, row.outcome, row.resolved_at !== null], ['done', 'ai-confirmed', true]);
  assert.deepEqual(await ours('apply'), []);

  await clean();
});
