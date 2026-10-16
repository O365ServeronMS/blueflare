/**
 * Catalog audit, step 4: write one gated action and keep what undo needs. Each action is its own
 * transaction (move_source: the ingest's own transaction plus a check afterwards). Returns
 * `{ status: 'applied'|'blocked'|'failed', gate?, before, after, identityChangeId?, slugs }`.
 * `undoAuditAction` reverses an applied action from the stored snapshot.
 *
 * Worker and scripts only; the gate (catalogAuditGate.js) has already passed the action.
 */
import { pool } from './db.js';
import { rowSeason, seasonInSlug } from './identity.js';
import { assignTmdbIdentity, rewriteTmdbIdentity, undoTmdbIdentity } from './tmdbIdentity.js';
import { sourceSeason } from './catalogAuditExtract.js';
import { preferredSlug } from './catalogAuditGate.js';

async function inTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query(result?.rollback ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const blocked = (gate, extra = {}) => ({ status: 'blocked', gate, rollback: true, slugs: [], ...extra });

async function setSeason(action, { evidence }) {
  return inTransaction(async (client) => {
    const row = (await client.query('SELECT * FROM movies WHERE id=$1 FOR UPDATE', [action.movieId])).rows[0];
    if (!row || row.tmdb_media_type !== 'tv' || row.tmdb_id === null) return blocked('row-changed');
    const identity = { id: Number(row.tmdb_id), mediaType: 'tv', season: Number(action.season) };
    const written = await rewriteTmdbIdentity(client, row.id, identity, { reason: 'catalog-audit:set_season', evidence });
    return {
      status: 'applied', before: written.before, after: { tmdb_season_number: identity.season },
      identityChangeId: written.changeId, slugs: [row.canonical_slug]
    };
  });
}

async function clearTmdb(action, { evidence }) {
  return inTransaction(async (client) => {
    const row = (await client.query('SELECT * FROM movies WHERE id=$1 FOR UPDATE', [action.movieId])).rows[0];
    if (!row || row.tmdb_id === null || row.tmdb_id_source !== 'inferred') return blocked('row-changed');
    const written = await rewriteTmdbIdentity(client, row.id, null, { reason: 'catalog-audit:clear_tmdb', evidence });
    return { status: 'applied', before: written.before, after: { tmdb_id: null }, identityChangeId: written.changeId, slugs: [row.canonical_slug] };
  });
}

async function mergeRows(action, detail, { evidence }) {
  const holder = (await pool.query('SELECT * FROM movies WHERE id=$1', [detail.withId])).rows[0];
  if (!holder || holder.tmdb_id === null) return blocked('row-changed');
  const result = await assignTmdbIdentity(detail.without, {
    tmdbId: Number(holder.tmdb_id), mediaType: holder.tmdb_media_type, season: holder.tmdb_season_number ?? null
  }, { source: 'inferred', evidence, mode: 'apply' });
  if (result.action !== 'merged') return blocked('identity:' + result.action + (result.reason ? ':' + result.reason : ''));
  return {
    status: 'applied', before: { keepId: result.survivorId, dropId: result.dropId, dropSlug: result.dropSlug },
    after: { survivorSlug: result.survivorSlug }, identityChangeId: result.changeId,
    slugs: [result.survivorSlug, result.dropSlug].filter(Boolean)
  };
}

async function fixAlias(action) {
  return inTransaction(async (client) => {
    const alias = (await client.query('SELECT * FROM movie_slug_aliases WHERE slug=$1 FOR UPDATE', [action.slug])).rows[0];
    if (!alias) return blocked('alias-gone');
    const target = (await client.query("SELECT id, canonical_slug FROM movies WHERE id=$1 AND catalog_state='ready'", [action.toMovieId])).rows[0];
    if (!target) return blocked('target-gone');
    const from = (await client.query('SELECT canonical_slug FROM movies WHERE id=$1', [alias.movie_id])).rows[0];
    // The target already answers the slug as its canonical slug: the alias is shadowed, drop it.
    if (target.canonical_slug === action.slug) await client.query('DELETE FROM movie_slug_aliases WHERE slug=$1', [action.slug]);
    else await client.query('UPDATE movie_slug_aliases SET movie_id=$2 WHERE slug=$1', [action.slug, target.id]);
    return {
      status: 'applied', before: { slug: action.slug, movieId: alias.movie_id },
      after: { movieId: target.id, dropped: target.canonical_slug === action.slug },
      slugs: [action.slug, target.canonical_slug, from?.canonical_slug].filter(Boolean)
    };
  });
}

async function freeSlug(client, preferred, year, movieId) {
  const candidates = [preferred, ...(year ? [preferred + '-' + year] : [])];
  for (let n = 2; n < 50; n += 1) candidates.push(preferred + '-' + n);
  for (const slug of candidates) {
    const taken = await client.query(
      'SELECT 1 FROM movies WHERE canonical_slug=$1 UNION ALL SELECT 1 FROM movie_slug_aliases WHERE slug=$1 AND movie_id<>$2 ' +
      'UNION ALL SELECT 1 FROM movie_provider_sources WHERE provider_slug=$1 AND movie_id<>$2 LIMIT 1', [slug, movieId]);
    if (!taken.rowCount) return slug;
  }
  return null;
}

async function renameSlug(action, detail) {
  return inTransaction(async (client) => {
    const row = (await client.query('SELECT * FROM movies WHERE id=$1 FOR UPDATE', [action.movieId])).rows[0];
    if (!row || row.catalog_state !== 'ready') return blocked('row-changed');
    const oldSlug = row.canonical_slug;
    const season = rowSeason(row);
    if (seasonInSlug(oldSlug) === season) return blocked('slug-agrees');
    const newSlug = await freeSlug(client, preferredSlug(row, season), row.year, row.id);
    if (!newSlug || seasonInSlug(newSlug) === seasonInSlug(oldSlug)) return blocked('no-free-slug');
    const ownAlias = (await client.query('DELETE FROM movie_slug_aliases WHERE slug=$1 AND movie_id=$2 RETURNING slug', [newSlug, row.id])).rowCount > 0;
    await client.query('UPDATE movies SET canonical_slug=$2, updated_at=now() WHERE id=$1', [row.id, newSlug]);
    // The old slug keeps working: it goes to the season it names when that row exists, else stays here.
    let oldTo = row.id;
    if (detail.sibling) {
      const sibling = (await client.query("SELECT id, canonical_slug FROM movies WHERE id=$1 AND catalog_state='ready'", [detail.sibling])).rows[0];
      if (sibling) oldTo = sibling.id;
    }
    await client.query('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET movie_id=EXCLUDED.movie_id', [oldSlug, oldTo]);
    return {
      status: 'applied', before: { movieId: row.id, slug: oldSlug, ownAlias },
      after: { slug: newSlug, oldSlugTo: oldTo }, slugs: [oldSlug, newSlug]
    };
  });
}

async function hideRow(action) {
  return inTransaction(async (client) => {
    const row = (await client.query('SELECT * FROM movies WHERE id=$1 FOR UPDATE', [action.movieId])).rows[0];
    if (!row || row.catalog_state !== 'ready') return blocked('row-changed');
    const live = await client.query('SELECT 1 FROM movie_provider_sources WHERE movie_id=$1 AND availability LIMIT 1', [row.id]);
    if (live.rowCount) return blocked('has-available-source');
    await client.query("UPDATE movies SET catalog_state='unavailable', updated_at=now() WHERE id=$1", [row.id]);
    return { status: 'applied', before: { catalog_state: row.catalog_state }, after: { catalog_state: 'unavailable' }, slugs: [row.canonical_slug] };
  });
}

/** Re-fetch one provider record and ingest it; `relocate` lets it pick its row afresh. */
async function reingest(deps, source, relocate) {
  const provider = deps.providers?.get(source.provider);
  if (!provider) throw new Error('provider ' + source.provider + ' not enabled');
  const { normalized } = await provider.detail(source.provider_slug);
  return deps.upsert(normalized, { relocate });
}

async function moveSource(action, detail, deps) {
  const source = (await pool.query(
    'SELECT s.*, m.canonical_slug, m.tmdb_season_number, m.title, m.original_title FROM movie_provider_sources s ' +
    'JOIN movies m ON m.id=s.movie_id WHERE s.id=$1', [action.sourceId])).rows[0];
  if (!source) return blocked('source-gone');
  const others = (await pool.query('SELECT * FROM movie_provider_sources WHERE movie_id=$1 AND id<>$2 AND availability', [source.movie_id, source.id])).rows;
  if (!others.length) return blocked('last-source');
  const startedAt = (await pool.query('SELECT now() AS at')).rows[0].at;
  const { movie } = await reingest(deps, source, true);
  const described = sourceSeason(source).season;
  const before = { sourceId: Number(source.id), movieId: source.movie_id, slug: source.canonical_slug };
  if (movie.id === source.movie_id) return { ...blocked('landed-on-same-row'), rollback: false, before };
  const created = new Date(movie.created_at) >= new Date(startedAt);
  const landedSeason = rowSeason(movie);
  const wrong = detail.basis === 'season' && landedSeason !== null && landedSeason !== described;
  if (wrong || (detail.expect && movie.id !== detail.expect && !created)) {
    await putSourceBack(before, movie.id, created);
    return { status: 'failed', gate: 'landed-wrong-row', before, after: { movieId: movie.id }, slugs: [] };
  }
  // The row it left still carries fields that record wrote: re-ingest what stays on it.
  const refreshed = [];
  for (const other of others) {
    try { await reingest(deps, other, false); refreshed.push(Number(other.id)); } catch { /* the next sync retries */ }
  }
  return {
    status: 'applied', before, after: { movieId: movie.id, slug: movie.canonical_slug, created, refreshed },
    slugs: [source.canonical_slug, movie.canonical_slug]
  };
}

async function putSourceBack(before, landedId, created) {
  await inTransaction(async (client) => {
    await client.query('UPDATE movie_provider_sources SET movie_id=$2, updated_at=now() WHERE id=$1', [before.sourceId, before.movieId]);
    if (created) {
      const left = await client.query('SELECT 1 FROM movie_provider_sources WHERE movie_id=$1 LIMIT 1', [landedId]);
      if (!left.rowCount) await client.query("UPDATE movies SET catalog_state='unavailable', updated_at=now() WHERE id=$1", [landedId]);
    }
  });
}

/**
 * Write one gated action. `verdict` is gateProposal's entry (action + detail). `deps.providers`
 * (name -> provider) and `deps.upsert` are needed by move_source only.
 */
export async function applyAuditAction(verdict, deps = {}) {
  const { action, detail = {} } = verdict;
  const evidence = { pass: 'catalog-audit', runId: deps.runId ?? null, reason: action.reason ?? null };
  try {
    let result;
    if (action.type === 'set_season') result = await setSeason(action, { evidence });
    else if (action.type === 'clear_tmdb') result = await clearTmdb(action, { evidence });
    else if (action.type === 'merge_rows') result = await mergeRows(action, detail, { evidence });
    else if (action.type === 'fix_alias') result = await fixAlias(action);
    else if (action.type === 'rename_slug') result = await renameSlug(action, detail);
    else if (action.type === 'hide_row') result = await hideRow(action);
    else if (action.type === 'move_source') result = await moveSource(action, detail, deps);
    else return { status: 'blocked', gate: 'not-applicable', slugs: [] };
    const { rollback, ...out } = result;
    return out;
  } catch (error) {
    return { status: 'failed', gate: 'error:' + String(error.message).slice(0, 160), slugs: [] };
  }
}

/** Reverse one applied catalog_audit_actions row. Returns `{ action: 'undone'|'noop', reason?, slugs }`. */
export async function undoAuditAction(actionId) {
  const row = (await pool.query('SELECT * FROM catalog_audit_actions WHERE id=$1', [actionId])).rows[0];
  if (!row) return { action: 'noop', reason: 'action-missing', slugs: [] };
  if (row.status !== 'applied') return { action: 'noop', reason: 'status-' + row.status, slugs: [] };
  const before = row.before || {};
  const after = row.after || {};
  let slugs = row.slugs || [];
  if (row.identity_change_id) {
    const undone = await undoTmdbIdentity(Number(row.identity_change_id));
    if (undone.action !== 'undone') return { action: 'noop', reason: undone.reason, slugs: [] };
    slugs = [...new Set([...slugs, ...(undone.slugs || [])])];
  } else if (row.action === 'fix_alias') {
    await pool.query('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET movie_id=EXCLUDED.movie_id',
      [before.slug, before.movieId]);
  } else if (row.action === 'rename_slug') {
    const reason = await inTransaction(async (client) => {
      const movie = (await client.query('SELECT canonical_slug FROM movies WHERE id=$1 FOR UPDATE', [before.movieId])).rows[0];
      if (!movie || movie.canonical_slug !== after.slug) return { rollback: true, reason: 'slug-changed-since' };
      const taken = await client.query('SELECT 1 FROM movies WHERE canonical_slug=$1 AND id<>$2', [before.slug, before.movieId]);
      if (taken.rowCount) return { rollback: true, reason: 'old-slug-taken' };
      await client.query('DELETE FROM movie_slug_aliases WHERE slug=$1', [before.slug]);
      await client.query('UPDATE movies SET canonical_slug=$2, updated_at=now() WHERE id=$1', [before.movieId, before.slug]);
      if (before.ownAlias) await client.query('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [after.slug, before.movieId]);
      return { reason: null };
    });
    if (reason.reason) return { action: 'noop', reason: reason.reason, slugs: [] };
  } else if (row.action === 'hide_row') {
    await pool.query("UPDATE movies SET catalog_state=$2, updated_at=now() WHERE id=$1 AND catalog_state='unavailable'", [row.params.movieId, before.catalog_state]);
  } else if (row.action === 'move_source') {
    await putSourceBack(before, after.movieId, after.created);
  } else {
    return { action: 'noop', reason: 'not-undoable', slugs: [] };
  }
  await pool.query("UPDATE catalog_audit_actions SET status='undone', undone_at=now() WHERE id=$1", [actionId]);
  return { action: 'undone', slugs };
}
