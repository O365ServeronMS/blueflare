import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

dbTest('listAiMatchCandidates: priority keeps new films and retries, all keeps the backlog, cast first', async () => {
  const { pool, migrate } = await import('../src/db.js');
  const { listAiMatchCandidates } = await import('../src/tmdbMatchAiSync.js');
  await migrate();
  await pool.query('DELETE FROM tmdb_match_ai_runs');
  await pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'ailist-%'");
  const insert = (slug, { created = 'now()', actors = '[]', run = null } = {}) => pool.query(
    "INSERT INTO movies (canonical_slug, title, normalized_title, original_title, year, media_type, catalog_state, actors, created_at) " +
    "VALUES ($1, $1, $1, 'Orig ' || $1, 2020, 'tv', 'ready', $2::jsonb, " + created + ') RETURNING id', [slug, actors]
  ).then(async (r) => {
    if (run) await pool.query("INSERT INTO tmdb_match_ai_runs (run_id, mode, movie_id, status, outcome, created_at) VALUES (gen_random_uuid(), 'dry-run', $1, 'error', $2, now() - interval '7 hours')", [r.rows[0].id, run]);
    return r.rows[0].id;
  });
  await insert('ailist-old', { created: "now() - interval '30 days'" });
  await insert('ailist-old-cast', { created: "now() - interval '30 days'", actors: '["A One","B Two"]' });
  await insert('ailist-new', {});
  await insert('ailist-retry', { created: "now() - interval '30 days'", run: 'error' });
  const base = { mode: 'dry-run', limit: 50, retryMs: 3600000, errorRetryMs: 3600000, freshMs: 3 * 86400000 };
  const all = (await listAiMatchCandidates({ ...base, scope: 'all' })).map((r) => r.canonical_slug).filter((s) => s.startsWith('ailist-'));
  assert.equal(all[0], 'ailist-old-cast', 'a cast of two or more goes first');
  assert.deepEqual(all.sort(), ['ailist-new', 'ailist-old', 'ailist-old-cast', 'ailist-retry']);
  const priority = (await listAiMatchCandidates({ ...base, scope: 'priority' })).map((r) => r.canonical_slug).filter((s) => s.startsWith('ailist-'));
  assert.deepEqual(priority.sort(), ['ailist-new', 'ailist-retry']);
  await pool.query('DELETE FROM tmdb_match_ai_runs');
  await pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'ailist-%'");
  await pool.end();
});
