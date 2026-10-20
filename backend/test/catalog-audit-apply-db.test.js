import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

const incoming = (slug, title = 'Auditapply ' + slug) => ({
  provider: 'kkphim', providerMovieId: 'id-' + slug, providerSlug: slug,
  priority: 20, title, originalTitle: null, normalizedTitle: title.toLowerCase(),
  normalizedOriginalTitle: null, mediaType: 'movie', displayType: 'single', year: 2020,
  tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null, imdbId: null,
  overview: null, thumbSourceUrl: null, posterSourceUrl: null, quality: null, language: null,
  status: null, episodeCurrent: null, episodeTotal: null, duration: null, actors: [], directors: [],
  genres: [], countries: [], ratings: {}, metadata: {}, streams: [], providerUpdatedAt: null
});

async function setup() {
  const { pool, migrate } = await import('../src/db.js');
  const repo = await import('../src/repository.js');
  const audit = await import('../src/catalogAuditApply.js');
  await migrate();
  const cleanup = async () => {
    await pool.query("DELETE FROM movie_slug_aliases WHERE slug LIKE 'auditapply-%'");
    await pool.query("DELETE FROM movies WHERE canonical_slug LIKE 'auditapply-%'");
    await pool.query("DELETE FROM catalog_audit_runs WHERE mode='test-auditapply'");
  };
  // Stores an apply result the way catalogAudit.js does, so undoAuditAction can read it back.
  const store = async (type, params, result) => {
    const { rows: [run] } = await pool.query("INSERT INTO catalog_audit_runs (mode) VALUES ('test-auditapply') RETURNING id");
    const { rows: [row] } = await pool.query(
      'INSERT INTO catalog_audit_actions (run_id, group_key, action, params, status, gate, before, after, slugs, identity_change_id) ' +
      "VALUES ($1,'g',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [run.id, type, params, result.status, result.gate ?? null, result.before ?? null, result.after ?? null,
        result.slugs ?? [], result.identityChangeId ?? null]);
    return row.id;
  };
  const movie = async (id) => (await pool.query('SELECT canonical_slug, catalog_state FROM movies WHERE id=$1', [id])).rows[0];
  const aliasOf = async (slug) => (await pool.query('SELECT movie_id FROM movie_slug_aliases WHERE slug=$1', [slug])).rows[0]?.movie_id ?? null;
  await cleanup();
  return { pool, repo, audit, cleanup, store, movie, aliasOf };
}

dbTest('catalog audit apply: hide_row refuses a row with a live source, hides it otherwise, undo restores it', async () => {
  const { pool, repo, audit, cleanup, store, movie } = await setup();
  try {
    const { movie: row } = await repo.upsertCanonical(incoming('auditapply-hide'));
    const action = { type: 'hide_row', movieId: row.id };

    const refused = await audit.applyAuditAction({ action });
    assert.equal(refused.status, 'blocked');
    assert.equal(refused.gate, 'has-available-source');
    assert.equal('rollback' in refused, false, 'the internal rollback flag is not returned');
    assert.equal((await movie(row.id)).catalog_state, 'ready');

    await pool.query('UPDATE movie_provider_sources SET availability=false WHERE movie_id=$1', [row.id]);
    const applied = await audit.applyAuditAction({ action });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.slugs, ['auditapply-hide']);
    assert.equal((await movie(row.id)).catalog_state, 'unavailable');
    assert.equal((await audit.applyAuditAction({ action })).gate, 'row-changed', 'a second apply is refused');

    const id = await store('hide_row', { movieId: row.id }, applied);
    assert.equal((await audit.undoAuditAction(id)).action, 'undone');
    assert.equal((await movie(row.id)).catalog_state, 'ready');
    const { rows: [logged] } = await pool.query('SELECT status, undone_at FROM catalog_audit_actions WHERE id=$1', [id]);
    assert.equal(logged.status, 'undone');
    assert.ok(logged.undone_at);
    assert.deepEqual(await audit.undoAuditAction(id), { action: 'noop', reason: 'status-undone', slugs: [] });
  } finally {
    await cleanup();
  }
});

dbTest('catalog audit apply: fix_alias re-points an alias, drops a shadowed one, undo puts it back', async () => {
  const { pool, repo, audit, cleanup, store, aliasOf } = await setup();
  try {
    const { movie: a } = await repo.upsertCanonical(incoming('auditapply-alias-a'));
    const { movie: b } = await repo.upsertCanonical(incoming('auditapply-alias-b'));
    await pool.query('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2)', ['auditapply-alias-old', a.id]);

    const moved = await audit.applyAuditAction({ action: { type: 'fix_alias', slug: 'auditapply-alias-old', toMovieId: b.id } });
    assert.equal(moved.status, 'applied');
    assert.equal(moved.after.dropped, false);
    assert.equal(await aliasOf('auditapply-alias-old'), b.id);
    assert.deepEqual(moved.slugs.sort(), ['auditapply-alias-a', 'auditapply-alias-b', 'auditapply-alias-old']);

    const id = await store('fix_alias', { slug: 'auditapply-alias-old', toMovieId: b.id }, moved);
    assert.equal((await audit.undoAuditAction(id)).action, 'undone');
    assert.equal(await aliasOf('auditapply-alias-old'), a.id);

    // An alias equal to the target's own canonical slug answers nothing: it is dropped.
    await pool.query('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2)', ['auditapply-alias-b', a.id]);
    const dropped = await audit.applyAuditAction({ action: { type: 'fix_alias', slug: 'auditapply-alias-b', toMovieId: b.id } });
    assert.equal(dropped.status, 'applied');
    assert.equal(dropped.after.dropped, true);
    assert.equal(await aliasOf('auditapply-alias-b'), null);

    assert.equal((await audit.applyAuditAction({ action: { type: 'fix_alias', slug: 'auditapply-alias-none', toMovieId: b.id } })).gate, 'alias-gone');
    await pool.query("UPDATE movies SET catalog_state='unavailable' WHERE id=$1", [b.id]);
    assert.equal((await audit.applyAuditAction({ action: { type: 'fix_alias', slug: 'auditapply-alias-old', toMovieId: b.id } })).gate, 'target-gone');
    assert.equal(await aliasOf('auditapply-alias-old'), a.id, 'a refused action writes nothing');
  } finally {
    await cleanup();
  }
});

dbTest('catalog audit apply: rename_slug moves a slug naming the wrong season, the old slug keeps resolving, undo restores it', async () => {
  const { pool, repo, audit, cleanup, store, movie, aliasOf } = await setup();
  try {
    const { movie: row } = await repo.upsertCanonical(incoming('auditapply-show-phan-3', 'Auditapply Show (Phần 2)'));
    const action = { type: 'rename_slug', movieId: row.id };

    const applied = await audit.applyAuditAction({ action, detail: {} });
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    const newSlug = applied.after.slug;
    assert.match(newSlug, /^auditapply-show-phan-2/);
    assert.equal((await movie(row.id)).canonical_slug, newSlug);
    assert.equal(await aliasOf('auditapply-show-phan-3'), row.id, 'the old slug becomes an alias of the same row');
    assert.equal(await repo.findMovieIdBySlug('auditapply-show-phan-3'), row.id);
    assert.deepEqual(applied.slugs, ['auditapply-show-phan-3', newSlug]);
    assert.equal((await audit.applyAuditAction({ action, detail: {} })).gate, 'slug-agrees', 'a second apply is refused');

    const id = await store('rename_slug', action, applied);
    assert.equal((await audit.undoAuditAction(id)).action, 'undone');
    assert.equal((await movie(row.id)).canonical_slug, 'auditapply-show-phan-3');
    assert.equal(await aliasOf('auditapply-show-phan-3'), null);
  } finally {
    await cleanup();
  }
});

dbTest('catalog audit apply: rename_slug undo refuses when the slug changed since', async () => {
  const { pool, repo, audit, cleanup, store, movie } = await setup();
  try {
    const { movie: row } = await repo.upsertCanonical(incoming('auditapply-later-phan-3', 'Auditapply Later (Phần 2)'));
    const applied = await audit.applyAuditAction({ action: { type: 'rename_slug', movieId: row.id }, detail: {} });
    assert.equal(applied.status, 'applied');
    await pool.query("UPDATE movies SET canonical_slug='auditapply-later-manual' WHERE id=$1", [row.id]);
    const id = await store('rename_slug', { movieId: row.id }, applied);
    assert.deepEqual(await audit.undoAuditAction(id), { action: 'noop', reason: 'slug-changed-since', slugs: [] });
    assert.equal((await movie(row.id)).canonical_slug, 'auditapply-later-manual');
  } finally {
    await cleanup();
    await pool.end();
  }
});
