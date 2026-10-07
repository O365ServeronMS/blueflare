/**
 * Assigns a TMDB identity (tmdb_id, media type, season) to a catalog row, folding in the
 * row that already holds it. One page = one (tmdb_id, tmdb_media_type, tmdb_season_number).
 *
 * The unique indexes on movies mean two rows can never both carry an identity, so assigning
 * is always "merge or assign" inside one transaction:
 *   - nobody holds the identity            -> write it on the row (action 'assigned')
 *   - another row holds it                 -> keep one survivor, move the other row's sources,
 *                                             favorites, history, aliases, reviews into it and
 *                                             delete it (action 'merged')
 * Every change is logged in tmdb_identity_changes (+ movie_merges for merges) so
 * undoTmdbIdentity can reverse it. Provider ids are never overwritten: a row that already
 * carries another identity is 'blocked'.
 *
 * Request paths never call this; the worker does (and the report/undo scripts).
 */
import { config } from './config.js';
import { pool } from './db.js';
import { nguoncSeason } from './duplicateMerge.js';
import { fetchTmdb } from './tmdb.js';
import { writeTmdbIdentity } from './repository.js';

const MEDIA_TYPES = new Set(['movie', 'tv']);
const BLOCK_RETRY_DAYS = 7;

/** Columns the merge may fill on the survivor and that undo can put back. */
const FILL_TEXT = ['original_title', 'normalized_original_title', 'display_type', 'year', 'imdb_id', 'overview',
  'quality', 'language', 'status', 'episode_current', 'episode_total', 'duration'];
const FILL_JSON = ['actors', 'directors', 'genres', 'countries'];
const IDENTITY_COLUMNS = ['tmdb_id', 'tmdb_media_type', 'tmdb_season_number', 'tmdb_id_source', 'tmdb_identity_status',
  'tmdb_identity_verified_at', 'tmdb_image_checked_at', 'tmdb_thumb_asset_id', 'tmdb_poster_asset_id'];
const ALL_RESTORABLE = new Set([...FILL_TEXT, ...FILL_JSON, ...IDENTITY_COLUMNS, 'thumb_source_url', 'thumb_asset_id',
  'poster_source_url', 'poster_asset_id', 'ratings', 'primary_provider', 'provider_updated_at', 'catalog_sort_at']);

const ts = (value) => (value ? new Date(value).getTime() : 0);
const blank = (value) => value === null || value === undefined || (typeof value === 'string' && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

function pickColumns(row, columns) {
  const out = {};
  for (const column of columns) out[column] = row[column] ?? null;
  return out;
}

export function validateIdentity({ tmdbId, mediaType } = {}) {
  const id = Number(tmdbId);
  if (!Number.isSafeInteger(id) || id <= 0 || !MEDIA_TYPES.has(mediaType)) return null;
  return { id, mediaType };
}

/**
 * Season of the page this row represents. Movies have none. A series needs one that is
 * evident: already stored on the row, a "(Phần N)" marker in title/slug, or TMDB reporting
 * a single season. Anything else is reported, never guessed.
 */
export function resolveSeason(row, mediaType, numberOfSeasons = null) {
  if (mediaType === 'movie') return { season: null };
  const total = Number(numberOfSeasons);
  const known = Number.isInteger(total) && total > 0 ? total : null;
  let season = null;
  if (Number.isInteger(row.tmdb_season_number) && row.tmdb_season_number >= 0) season = row.tmdb_season_number;
  else season = nguoncSeason(row);
  if (season === null && known === 1) season = 1;
  if (season === null) return { season: null, blocked: 'season-unknown' };
  if (season < 1 || (known && season > known)) return { season, blocked: 'season-out-of-range' };
  return { season };
}

/** True when resolveSeason would need TMDB's season count to decide. */
export function needsSeasonCount(row, mediaType) {
  if (mediaType !== 'tv') return false;
  return resolveSeason(row, mediaType, null).blocked === 'season-unknown';
}

function completeness(row) {
  const fields = [row.overview, row.actors, row.directors, row.genres, row.countries, row.year,
    row.thumb_asset_id, row.poster_asset_id, row.imdb_id, row.original_title];
  return fields.filter((value) => !blank(value)).length;
}

/**
 * Survivor of a set of rows describing one page: most distinct provider sources, then one
 * that has KKPhim, then fuller metadata, then the oldest row. `rows[i].providers` is an array.
 */
export function chooseSurvivor(rows) {
  const ranked = [...rows].sort((a, b) =>
    (b.providers.length - a.providers.length) ||
    (Number(b.providers.includes('kkphim')) - Number(a.providers.includes('kkphim'))) ||
    (completeness(b) - completeness(a)) ||
    (ts(a.created_at) - ts(b.created_at)) ||
    String(a.id).localeCompare(String(b.id)));
  const [first, second] = ranked;
  let reason = 'oldest-row';
  if (second) {
    if (first.providers.length !== second.providers.length) reason = 'more-providers';
    else if (first.providers.includes('kkphim') !== second.providers.includes('kkphim')) reason = 'has-kkphim';
    else if (completeness(first) !== completeness(second)) reason = 'fuller-metadata';
  }
  return { survivor: first, drops: ranked.slice(1), reason };
}

/** Folding an inferred identity into a holder is refused when the two rows plainly differ. */
export function mergeGuard(target, holder, source) {
  if (source !== 'inferred') return null;
  if (target.imdb_id && holder.imdb_id && target.imdb_id !== holder.imdb_id) return 'imdb-differs';
  if (Number.isInteger(target.year) && Number.isInteger(holder.year) && Math.abs(target.year - holder.year) > 1) return 'year-differs';
  return null;
}

async function providersOf(db, ids) {
  const result = await db.query(
    'SELECT movie_id, array_agg(DISTINCT provider ORDER BY provider) AS providers FROM movie_provider_sources ' +
    'WHERE movie_id = ANY($1::uuid[]) GROUP BY movie_id', [ids]
  );
  return new Map(result.rows.map((row) => [row.movie_id, row.providers]));
}

/** Core planner. `lock` makes the reads FOR UPDATE (inside the apply transaction). */
async function planWith(db, movieId, input, { source = 'inferred', lock = false } = {}) {
  const identity = validateIdentity(input);
  if (!identity) return { action: 'blocked', reason: 'invalid-identity', season: null };
  const suffix = lock ? ' FOR UPDATE' : '';
  const target = (await db.query('SELECT * FROM movies WHERE id=$1' + suffix, [movieId])).rows[0];
  if (!target) return { action: 'blocked', reason: 'row-missing', season: null };
  const base = { survivorId: target.id, survivorSlug: target.canonical_slug };
  const resolved = resolveSeason(target, identity.mediaType, input.numberOfSeasons);
  const season = resolved.season;
  if (resolved.blocked) return { ...base, action: 'blocked', reason: resolved.blocked, season };
  if (target.catalog_state !== 'ready') return { ...base, action: 'blocked', reason: 'not-ready', season };

  if (target.tmdb_id !== null && target.tmdb_id !== undefined) {
    const same = Number(target.tmdb_id) === identity.id && target.tmdb_media_type === identity.mediaType &&
      (target.tmdb_season_number ?? null) === season;
    return same
      ? { ...base, action: 'noop', reason: 'already-assigned', season, target }
      : { ...base, action: 'blocked', reason: 'row-has-other-identity', season };
  }

  const holders = (await db.query(
    'SELECT * FROM movies WHERE tmdb_id=$1 AND tmdb_media_type=$2 AND id<>$3 AND ' +
    "(tmdb_media_type='movie' OR tmdb_season_number IS NOT DISTINCT FROM $4) ORDER BY id" + suffix,
    [identity.id, identity.mediaType, target.id, season]
  )).rows;
  if (holders.length === 0) return { ...base, action: 'assign', season, identity, target };
  if (holders.length > 1) return { ...base, action: 'blocked', reason: 'multiple-holders', season };

  const holder = holders[0];
  if (holder.catalog_state !== 'ready') return { ...base, action: 'blocked', reason: 'holder-not-ready', season };
  const guard = mergeGuard(target, holder, source);
  if (guard) return { ...base, action: 'blocked', reason: guard, season };
  const providers = await providersOf(db, [target.id, holder.id]);
  const rows = [target, holder].map((row) => ({ ...row, providers: providers.get(row.id) || [] }));
  const { survivor, drops, reason } = chooseSurvivor(rows);
  const drop = drops[0];
  return {
    action: 'merge', season, identity, reason: 'survivor:' + reason,
    survivorId: survivor.id, survivorSlug: survivor.canonical_slug,
    dropId: drop.id, dropSlug: drop.canonical_slug, target, holder, survivor, drop
  };
}

function publicPlan(plan) {
  const { action, survivorId, survivorSlug, dropId, dropSlug, season, reason } = plan;
  const out = { action, survivorId, survivorSlug, season };
  if (dropId) { out.dropId = dropId; out.dropSlug = dropSlug; }
  if (reason) out.reason = reason;
  return out;
}

/** Same planner on a caller-owned connection (the report script passes a read-only one). Returns the full plan with rows. */
export const planTmdbIdentityWith = (db, movieId, input, options) => planWith(db, movieId, input, options);

/** Read-only plan. */
export async function planTmdbIdentity(movieId, input, options = {}) {
  return publicPlan(await planWith(pool, movieId, input, options));
}

async function logChange(db, entry) {
  const result = await db.query(
    'INSERT INTO tmdb_identity_changes (movie_id, kind, source, tmdb_id, media_type, season, reason, evidence, before, merge_id, meta) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb) RETURNING id',
    [entry.movieId, entry.kind, entry.source ?? null, entry.tmdbId ?? null, entry.mediaType ?? null, entry.season ?? null,
      entry.reason ?? null, JSON.stringify(entry.evidence ?? null), JSON.stringify(entry.before ?? null),
      entry.mergeId ?? null, JSON.stringify(entry.meta ?? null)]
  );
  return result.rows[0].id;
}

/** blocked/conflict decisions: best effort and at most once a day per reason, never fatal. */
async function logDeclined(kind, movieId, input, season, reason, source, evidence) {
  try {
    await pool.query(
      'INSERT INTO tmdb_identity_changes (movie_id, kind, source, tmdb_id, media_type, season, reason, evidence) ' +
      'SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb WHERE NOT EXISTS (SELECT 1 FROM tmdb_identity_changes WHERE movie_id=$1 AND kind=$2 ' +
      "AND reason IS NOT DISTINCT FROM $7 AND created_at > now() - interval '1 day')",
      [movieId, kind, source, Number(input.tmdbId) || null, input.mediaType ?? null, season ?? null, reason, JSON.stringify(evidence ?? null)]
    );
  } catch { /* log table not migrated yet; the decision itself is still returned */ }
}

async function tableExists(db, name) {
  return Boolean((await db.query('SELECT to_regclass($1) AS t', [name])).rows[0].t);
}

/** UPDATE movies SET <cols> from a JSON object of values (typed through the movies row type). */
async function setColumns(client, id, values) {
  const columns = Object.keys(values);
  if (!columns.length) return;
  for (const column of columns) if (!ALL_RESTORABLE.has(column)) throw new Error('column not restorable: ' + column);
  await client.query(
    'UPDATE movies SET ' + columns.map((c) => `${c}=r.${c}`).join(', ') + ', updated_at=now() ' +
    'FROM jsonb_populate_record(null::movies, $2::jsonb) r WHERE movies.id=$1',
    [id, JSON.stringify(values)]
  );
}

function fillPlan(survivor, drop, sourcesAfter) {
  const values = {};
  for (const column of FILL_TEXT) if (blank(survivor[column]) && !blank(drop[column])) values[column] = drop[column];
  for (const column of FILL_JSON) if (blank(survivor[column]) && !blank(drop[column])) values[column] = drop[column];
  if (blank(survivor.thumb_source_url) && !blank(drop.thumb_source_url)) {
    values.thumb_source_url = drop.thumb_source_url;
    values.thumb_asset_id = drop.thumb_asset_id;
  } else if (!survivor.thumb_asset_id && drop.thumb_asset_id && survivor.thumb_source_url === drop.thumb_source_url) {
    values.thumb_asset_id = drop.thumb_asset_id;
  }
  if (blank(survivor.poster_source_url) && !blank(drop.poster_source_url)) {
    values.poster_source_url = drop.poster_source_url;
    values.poster_asset_id = drop.poster_asset_id;
  } else if (!survivor.poster_asset_id && drop.poster_asset_id && survivor.poster_source_url === drop.poster_source_url) {
    values.poster_asset_id = drop.poster_asset_id;
  }
  const ratings = { ...(drop.ratings || {}), ...(survivor.ratings || {}) };
  if (JSON.stringify(ratings) !== JSON.stringify(survivor.ratings || {})) values.ratings = ratings;
  if (sourcesAfter.includes('nguonc') && survivor.primary_provider !== 'nguonc') values.primary_provider = 'nguonc';
  const later = (a, b) => (ts(a) >= ts(b) ? a : b);
  const updatedAt = later(survivor.provider_updated_at, drop.provider_updated_at);
  if (updatedAt && updatedAt !== survivor.provider_updated_at) values.provider_updated_at = updatedAt;
  const sortAt = later(survivor.catalog_sort_at, drop.catalog_sort_at);
  if (sortAt && sortAt !== survivor.catalog_sort_at) values.catalog_sort_at = sortAt;
  return values;
}

/** Folds `plan.drop` into `plan.survivor` and gives the survivor the identity. Runs inside the caller's transaction. */
async function mergeRows(client, plan, { source, evidence }) {
  const { survivor, drop, holder, identity, season } = plan;
  const survivorIsHolder = survivor.id === holder.id;
  const q = (sql, params) => client.query(sql, params);

  const sourceIds = (await q('SELECT id FROM movie_provider_sources WHERE movie_id=$1', [drop.id])).rows.map((r) => r.id);
  const favorites = (await q('SELECT * FROM user_favorites WHERE movie_id=$1', [drop.id])).rows;
  const history = (await q('SELECT * FROM user_history WHERE movie_id=$1', [drop.id])).rows;
  const hero = (await q('SELECT * FROM hero_trending_entries WHERE movie_id=$1', [drop.id])).rows;
  const reviewIds = (await q(
    'SELECT id FROM movie_reviews WHERE movie_id=$1 AND tmdb_review_id NOT IN (SELECT tmdb_review_id FROM movie_reviews WHERE movie_id=$2)',
    [drop.id, survivor.id])).rows.map((r) => r.id);
  const aliasSlugs = (await q('SELECT slug FROM movie_slug_aliases WHERE movie_id=$1', [drop.id])).rows.map((r) => r.slug);
  const aiRuns = (await tableExists(client, 'tmdb_match_ai_runs'))
    ? (await q(
      'SELECT id FROM tmdb_match_ai_runs WHERE movie_id=$1 AND run_id NOT IN (SELECT run_id FROM tmdb_match_ai_runs WHERE movie_id=$2)',
      [drop.id, survivor.id])).rows.map((r) => r.id)
    : [];
  const keptFavorites = new Set((await q('SELECT user_id FROM user_favorites WHERE movie_id=$1', [survivor.id])).rows.map((r) => r.user_id));
  const keptHistory = new Map((await q('SELECT * FROM user_history WHERE movie_id=$1', [survivor.id])).rows.map((r) => [r.user_id, r]));
  const favoritesInserted = favorites.map((r) => r.user_id).filter((u) => !keptFavorites.has(u));
  const historyInserted = history.map((r) => r.user_id).filter((u) => !keptHistory.has(u));
  const historyOverwritten = history
    .filter((r) => keptHistory.has(r.user_id) && r.watched_at > keptHistory.get(r.user_id).watched_at)
    .map((r) => keptHistory.get(r.user_id));

  const merge = (await q(
    'INSERT INTO movie_merges (kept_movie_id, kept_slug, dropped_movie_id, dropped_slug, dropped_row, kept_row_before, ' +
    'moved_source_ids, favorites, history, hero) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [survivor.id, survivor.canonical_slug, drop.id, drop.canonical_slug, JSON.stringify(drop), JSON.stringify(survivor),
      sourceIds, JSON.stringify(favorites), JSON.stringify(history), JSON.stringify(hero)]
  )).rows[0];

  await q('UPDATE movie_provider_sources SET movie_id=$1, updated_at=now() WHERE movie_id=$2', [survivor.id, drop.id]);
  await q('INSERT INTO user_favorites (user_id, movie_id, created_at) SELECT user_id, $1, created_at FROM user_favorites ' +
    'WHERE movie_id=$2 ON CONFLICT DO NOTHING', [survivor.id, drop.id]);
  await q(
    'INSERT INTO user_history (user_id, movie_id, watched_at, server_name, episode_key, episode_name) ' +
    'SELECT user_id, $1, watched_at, server_name, episode_key, episode_name FROM user_history WHERE movie_id=$2 ' +
    'ON CONFLICT (user_id, movie_id) DO UPDATE SET watched_at=EXCLUDED.watched_at, server_name=EXCLUDED.server_name, ' +
    'episode_key=EXCLUDED.episode_key, episode_name=EXCLUDED.episode_name WHERE EXCLUDED.watched_at > user_history.watched_at',
    [survivor.id, drop.id]);
  const heroMoved = hero.length > 0 && (await q(
    'UPDATE hero_trending_entries SET movie_id=$1 WHERE movie_id=$2 AND NOT EXISTS (SELECT 1 FROM hero_trending_entries WHERE movie_id=$1)',
    [survivor.id, drop.id])).rowCount > 0;
  if (reviewIds.length) await q('UPDATE movie_reviews SET movie_id=$1 WHERE id = ANY($2::uuid[])', [survivor.id, reviewIds]);
  if (aiRuns.length) await q('UPDATE tmdb_match_ai_runs SET movie_id=$1 WHERE id = ANY($2::bigint[])', [survivor.id, aiRuns]);
  await q('UPDATE movie_slug_aliases SET movie_id=$1 WHERE movie_id=$2', [survivor.id, drop.id]);
  await q('DELETE FROM movies WHERE id=$1', [drop.id]);
  await q('INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET movie_id=EXCLUDED.movie_id',
    [drop.canonical_slug, survivor.id]);

  const identityBefore = pickColumns(survivor, IDENTITY_COLUMNS);
  if (!survivorIsHolder) {
    // The identity (and its verified image state) comes from the row that held it.
    const heldSource = holder.tmdb_id_source || 'provider';
    await writeTmdbIdentity(client, survivor.id, { id: identity.id, mediaType: identity.mediaType, season }, heldSource);
    if (holder.tmdb_identity_status === 'verified') {
      await setColumns(client, survivor.id, pickColumns(holder, ['tmdb_identity_status', 'tmdb_identity_verified_at',
        'tmdb_image_checked_at', 'tmdb_thumb_asset_id', 'tmdb_poster_asset_id']));
    }
  }
  const sourcesAfter = (await q('SELECT DISTINCT provider FROM movie_provider_sources WHERE movie_id=$1', [survivor.id])).rows.map((r) => r.provider);
  const fill = fillPlan(survivor, drop, sourcesAfter);
  const changedBefore = pickColumns(survivor, Object.keys(fill));
  await setColumns(client, survivor.id, fill);

  const changeId = await logChange(client, {
    movieId: survivor.id, kind: 'merge', source, tmdbId: identity.id, mediaType: identity.mediaType, season,
    reason: plan.reason, evidence, before: identityBefore, mergeId: merge.id,
    meta: {
      dropId: drop.id, dropSlug: drop.canonical_slug, survivorIsHolder, favoritesInserted, historyInserted,
      historyOverwritten, reviewIds, heroMoved, aliasSlugs, aiRuns, changedBefore
    }
  });
  return { changeId, mergeId: merge.id };
}

async function runApply(movieId, input, { source, evidence }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock every row the unlocked plan touches in id order, then plan again on the locked rows.
    const preview = await planWith(client, movieId, input, { source });
    const ids = [preview.survivorId, preview.dropId, preview.target?.id, preview.holder?.id].filter(Boolean);
    if (ids.length) await client.query('SELECT id FROM movies WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...new Set(ids)]]);
    const plan = await planWith(client, movieId, input, { source, lock: true });
    if (plan.action === 'noop' || plan.action === 'blocked') {
      await client.query('ROLLBACK');
      return { plan };
    }
    if (plan.action === 'assign') {
      const before = pickColumns(plan.target, IDENTITY_COLUMNS);
      const row = await writeTmdbIdentity(client, movieId, { id: plan.identity.id, mediaType: plan.identity.mediaType, season: plan.season }, source);
      const changeId = await logChange(client, {
        movieId, kind: 'assign', source, tmdbId: plan.identity.id, mediaType: plan.identity.mediaType, season: plan.season, evidence, before
      });
      await client.query('COMMIT');
      return { plan, changeId, row };
    }
    const result = await mergeRows(client, plan, { source, evidence });
    await client.query('COMMIT');
    return { plan, ...result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Assign (or merge into) the TMDB identity for one catalog row.
 * mode 'dry-run' plans only and never writes; 'off' does nothing; anything else executes.
 * Never throws for data conflicts: a unique-index race returns action 'conflict'.
 */
export async function assignTmdbIdentity(movieId, input, { source = 'inferred', evidence = null, mode } = {}) {
  if (mode === 'off') return { action: 'noop', reason: 'mode-off', survivorId: movieId };
  if (mode === 'dry-run') {
    const plan = await planWith(pool, movieId, input, { source });
    const out = publicPlan(plan);
    if (plan.action === 'assign' || plan.action === 'merge') return { ...out, action: 'planned', plan: plan.action };
    return out;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { plan, changeId, mergeId } = await runApply(movieId, input, { source, evidence });
      const out = publicPlan(plan);
      if (plan.action === 'noop') return out;
      if (plan.action === 'blocked') {
        await logDeclined('blocked', movieId, input, plan.season, plan.reason, source, evidence);
        return out;
      }
      return { ...out, action: plan.action === 'merge' ? 'merged' : 'assigned', changeId, ...(mergeId ? { mergeId } : {}) };
    } catch (error) {
      if (error?.code !== '23505') throw error;
      if (attempt === 0) continue; // a sync created the holder meanwhile: re-plan once
      const reason = 'unique:' + (error.constraint || 'unknown');
      await logDeclined('conflict', movieId, input, null, reason, source, evidence);
      return { action: 'conflict', survivorId: movieId, reason };
    }
  }
  return { action: 'conflict', survivorId: movieId, reason: 'unique:unknown' };
}

// ---------------------------------------------------------------------------------------------
// Promotion of verified tmdb_match_* rows
// ---------------------------------------------------------------------------------------------

export async function listPromotionCandidates(limit = config.tmdbIdentityPromoteBatch, { afterId = null, db = pool } = {}) {
  const logged = await tableExists(db, 'tmdb_identity_changes');
  const skip = logged
    ? 'AND NOT EXISTS (SELECT 1 FROM tmdb_identity_changes c WHERE c.movie_id=m.id AND c.kind IN (\'blocked\',\'conflict\') ' +
      `AND (c.reason='undone' OR c.created_at > now() - interval '${BLOCK_RETRY_DAYS} days')) `
    : '';
  const result = await db.query(
    'SELECT m.* FROM movies m ' +
    "WHERE m.catalog_state='ready' AND m.tmdb_id IS NULL AND m.tmdb_match_status='verified' AND m.tmdb_match_id IS NOT NULL " +
    'AND m.tmdb_match_media_type IS NOT NULL AND ($2::uuid IS NULL OR m.id > $2::uuid) ' + skip +
    'ORDER BY m.id LIMIT $1',
    [Math.max(1, Math.floor(limit)), afterId]
  );
  return result.rows;
}

/** TMDB's season count for a series; null when unknown. Network: worker/scripts only. */
export async function tmdbSeasonCount(tmdbId, options = {}) {
  const body = await fetchTmdb('/tv/' + tmdbId, { language: '', ...options });
  const total = Number(body?.number_of_seasons);
  return Number.isInteger(total) && total > 0 ? total : null;
}

/**
 * Promote one small batch of cast-verified matches to real identities (source 'inferred').
 * `seasonsFor(tmdbId)` supplies a series' season count only when its season is not evident
 * from the row; it defaults to TMDB when a key is configured. In dry-run nothing is written,
 * so callers page with `afterId` (the returned `lastId`).
 */
export async function promoteVerifiedMatches({
  mode = config.tmdbIdentityMode, limit = config.tmdbIdentityPromoteBatch, afterId = null, seasonsFor, assign = assignTmdbIdentity, list = listPromotionCandidates
} = {}) {
  const stats = { mode, checked: 0, assigned: 0, merged: 0, planned: { assign: 0, merge: 0 }, noop: 0, blocked: 0, conflict: 0, reasons: {}, slugs: [], lastId: afterId };
  if (mode === 'off') return stats;
  const lookup = seasonsFor ?? (config.tmdbEnabled && config.tmdbApiKey ? tmdbSeasonCount : null);
  const rows = await list(limit, { afterId });
  const slugs = new Set();
  for (const row of rows) {
    stats.checked += 1;
    stats.lastId = row.id;
    const mediaType = row.tmdb_match_media_type;
    let numberOfSeasons = null;
    if (lookup && needsSeasonCount(row, mediaType)) {
      try { numberOfSeasons = await lookup(Number(row.tmdb_match_id)); } catch { numberOfSeasons = null; }
    }
    const result = await assign(row.id, { tmdbId: Number(row.tmdb_match_id), mediaType, numberOfSeasons },
      { source: 'inferred', evidence: row.tmdb_match_evidence ?? null, mode });
    if (result.action === 'planned') stats.planned[result.plan] += 1;
    else if (result.action === 'assigned') stats.assigned += 1;
    else if (result.action === 'merged') stats.merged += 1;
    else if (result.action in stats) stats[result.action] += 1;
    if (result.reason && !['planned', 'assigned', 'merged'].includes(result.action)) {
      stats.reasons[result.reason] = (stats.reasons[result.reason] || 0) + 1;
    }
    if (result.action === 'assigned' || result.action === 'merged') {
      if (result.survivorSlug) slugs.add(result.survivorSlug);
      if (result.droppedSlug ?? result.dropSlug) slugs.add(result.droppedSlug ?? result.dropSlug);
    }
  }
  stats.slugs = [...slugs];
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------------

/**
 * Reverses one tmdb_identity_changes row (kind 'assign' or 'merge'). Refuses when the identity
 * has changed since. Restores the dropped row, its sources, favorites and history, and the
 * survivor's overwritten fields; hero_trending_entries is a derived snapshot and is only moved
 * back when it moved. The restored titles are marked 'undone' so promotion never retries them.
 */
export async function undoTmdbIdentity(changeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const change = (await client.query('SELECT * FROM tmdb_identity_changes WHERE id=$1 FOR UPDATE', [changeId])).rows[0];
    if (!change || !['assign', 'merge'].includes(change.kind)) {
      await client.query('ROLLBACK');
      return { action: 'noop', reason: change ? 'not-undoable' : 'change-missing' };
    }
    if (change.undone_at) { await client.query('ROLLBACK'); return { action: 'noop', reason: 'already-undone' }; }
    const row = (await client.query('SELECT * FROM movies WHERE id=$1 FOR UPDATE', [change.movie_id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return { action: 'noop', reason: 'row-missing' }; }
    const holdsIdentity = Number(row.tmdb_id) === Number(change.tmdb_id) && row.tmdb_media_type === change.media_type &&
      (row.tmdb_season_number ?? null) === (change.season ?? null);
    if (!holdsIdentity) { await client.query('ROLLBACK'); return { action: 'noop', reason: 'identity-changed-since' }; }

    const restoreIdentity = () => setColumns(client, row.id, change.before || {});
    const slugs = [row.canonical_slug];
    let restoredId = row.id;
    if (change.kind === 'assign') {
      await restoreIdentity();
    } else {
      const meta = change.meta || {};
      const merge = (await client.query('SELECT * FROM movie_merges WHERE id=$1', [change.merge_id])).rows[0];
      if (!merge) { await client.query('ROLLBACK'); return { action: 'noop', reason: 'snapshot-missing' }; }
      const exists = (await client.query('SELECT 1 FROM movies WHERE id=$1 OR canonical_slug=$2', [merge.dropped_movie_id, merge.dropped_slug])).rowCount;
      if (exists) { await client.query('ROLLBACK'); return { action: 'noop', reason: 'dropped-row-exists' }; }
      restoredId = merge.dropped_movie_id;
      slugs.push(merge.dropped_slug);
      // Survivor first (frees the identity if it took it from the holder), then the dropped row.
      await restoreIdentity();
      await setColumns(client, row.id, meta.changedBefore || {});
      await client.query('DELETE FROM movie_slug_aliases WHERE slug=$1', [merge.dropped_slug]);
      await client.query('INSERT INTO movies SELECT (jsonb_populate_record(null::movies, $1::jsonb)).*', [JSON.stringify(merge.dropped_row)]);
      await client.query('UPDATE movie_provider_sources SET movie_id=$1, updated_at=now() WHERE id = ANY($2::bigint[]) AND movie_id=$3',
        [restoredId, merge.moved_source_ids, row.id]);
      if (meta.favoritesInserted?.length) {
        await client.query('DELETE FROM user_favorites WHERE movie_id=$1 AND user_id = ANY($2::uuid[])', [row.id, meta.favoritesInserted]);
      }
      for (const favorite of merge.favorites || []) {
        await client.query('INSERT INTO user_favorites (user_id, movie_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [favorite.user_id, restoredId, favorite.created_at]);
      }
      if (meta.historyInserted?.length) {
        await client.query('DELETE FROM user_history WHERE movie_id=$1 AND user_id = ANY($2::uuid[])', [row.id, meta.historyInserted]);
      }
      for (const kept of meta.historyOverwritten || []) {
        await client.query(
          'UPDATE user_history SET watched_at=$3, server_name=$4, episode_key=$5, episode_name=$6 WHERE user_id=$1 AND movie_id=$2',
          [kept.user_id, row.id, kept.watched_at, kept.server_name, kept.episode_key, kept.episode_name]);
      }
      for (const entry of merge.history || []) {
        await client.query(
          'INSERT INTO user_history (user_id, movie_id, watched_at, server_name, episode_key, episode_name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [entry.user_id, restoredId, entry.watched_at, entry.server_name, entry.episode_key, entry.episode_name]);
      }
      if (meta.heroMoved) {
        await client.query('UPDATE hero_trending_entries SET movie_id=$1 WHERE movie_id=$2', [restoredId, row.id]);
      }
      if (meta.reviewIds?.length) await client.query('UPDATE movie_reviews SET movie_id=$1 WHERE id = ANY($2::uuid[]) AND movie_id=$3', [restoredId, meta.reviewIds, row.id]);
      if (meta.aiRuns?.length) await client.query('UPDATE tmdb_match_ai_runs SET movie_id=$1 WHERE id = ANY($2::bigint[]) AND movie_id=$3', [restoredId, meta.aiRuns, row.id]);
      if (meta.aliasSlugs?.length) await client.query('UPDATE movie_slug_aliases SET movie_id=$1 WHERE slug = ANY($2::text[])', [restoredId, meta.aliasSlugs]);
    }
    await client.query('UPDATE tmdb_identity_changes SET undone_at=now() WHERE id=$1', [changeId]);
    for (const id of new Set([row.id, restoredId])) {
      await logChange(client, { movieId: id, kind: 'blocked', source: change.source, tmdbId: change.tmdb_id, mediaType: change.media_type, season: change.season, reason: 'undone' });
    }
    await client.query('COMMIT');
    return { action: 'undone', kind: change.kind, survivorId: row.id, restoredId, slugs };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
