/**
 * Worker pass: resolves the TMDB season of tv rows whose TMDB id is already known (AI-verified
 * but blocked 'season-unknown', or promotion-verified) and assigns it through tmdbIdentity.js, so
 * every change is logged in tmdb_identity_changes and undoable. Worker only, never a request path.
 */
import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { pool } from './db.js';
import { assignTmdbIdentity, recordDeclinedIdentity } from './tmdbIdentity.js';
import { createTmdbClient } from './tmdbMatchAi.js';
import { inferSeasonFromTmdb } from './tmdbSeasonInfer.js';

const BLOCK_RETRY_DAYS = 7;
const PASS = 'season-infer';

// Dry-run writes nothing, so without a cursor every cycle would replay the same batch.
const dryRunCursor = { afterId: null };

/**
 * Ready, identity-less rows with a verified tv id from either source. The AI run counts only when it
 * is the latest run of the row and stopped on 'season-unknown'.
 */
export async function listSeasonInferCandidates(limit = config.tmdbSeasonInferBatch, { afterId = null, db = pool } = {}) {
  const result = await db.query(
    'SELECT m.*, COALESCE(CASE WHEN m.tmdb_match_status=\'verified\' AND m.tmdb_match_media_type=\'tv\' THEN m.tmdb_match_id END, ai.tv_id) AS candidate_tmdb_id, ' +
    'ai.run_id AS ai_run_id FROM movies m ' +
    'LEFT JOIN LATERAL (SELECT r.run_id, substring(r.evidence->>\'key\' from \'^tv:(\\d+)$\')::bigint AS tv_id FROM tmdb_match_ai_runs r ' +
    "  WHERE r.movie_id=m.id AND r.status='skipped' AND r.outcome='verified' AND r.evidence->>'actionReason'='season-unknown' " +
    "    AND r.id = (SELECT max(l.id) FROM tmdb_match_ai_runs l WHERE l.movie_id=m.id)) ai ON true " +
    "WHERE m.catalog_state='ready' AND m.tmdb_id IS NULL " +
    "AND ((m.tmdb_match_status='verified' AND m.tmdb_match_id IS NOT NULL AND m.tmdb_match_media_type='tv') OR ai.tv_id IS NOT NULL) " +
    "AND ($2::uuid IS NULL OR m.id > $2::uuid) " +
    'AND NOT EXISTS (SELECT 1 FROM tmdb_identity_changes c WHERE c.movie_id=m.id AND c.kind IN (\'blocked\',\'conflict\') ' +
    `AND (c.reason='undone' OR (c.evidence->>'pass'='${PASS}' AND c.created_at > now() - interval '${BLOCK_RETRY_DAYS} days'))) ` +
    'ORDER BY m.id LIMIT $1',
    [Math.max(1, Math.floor(limit)), afterId]
  );
  return result.rows;
}

/**
 * One batch. `deps` overrides (tests): settings, list, assign, record, client.
 * Returns stats with `slugs` (survivor and dropped slugs of every change) for cache invalidation.
 */
export async function refreshSeasonInference(deps = {}) {
  const settings = deps.settings ?? config;
  const mode = deps.mode ?? settings.tmdbSeasonInferMode;
  const stats = { mode, checked: 0, planned: 0, assigned: 0, merged: 0, blocked: 0, conflict: 0, errors: 0, reasons: {}, slugs: [] };
  if (mode === 'off') return stats;
  if (!deps.client && !(settings.tmdbEnabled && settings.tmdbApiKey)) {
    stats.skipped = 'no-tmdb';
    return stats;
  }
  const assign = deps.assign ?? assignTmdbIdentity;
  const record = deps.record ?? recordDeclinedIdentity;
  const list = deps.list ?? listSeasonInferCandidates;
  const apply = mode === 'apply';
  const rows = await list(settings.tmdbSeasonInferBatch, { afterId: apply ? null : dryRunCursor.afterId });
  if (!apply) dryRunCursor.afterId = rows.length ? rows[rows.length - 1].id : null;
  if (!rows.length) return stats;

  // One /tv/{id} per distinct id this cycle; the client owns TMDB concurrency, 429 backoff and the 404 -> null case.
  const client = deps.client ?? createTmdbClient({ concurrency: Math.min(4, settings.tmdbMatchConcurrency ?? 2), cache: new SimpleCache() });
  const ids = [...new Set(rows.map((row) => Number(row.candidate_tmdb_id)))];
  const shows = new Map();
  await mapLimit(ids, Math.min(4, settings.tmdbMatchConcurrency ?? 2), async (id) => {
    try { shows.set(id, await client.get('/tv/' + id, { language: '' })); } catch { shows.set(id, undefined); }
  });

  const bump = (reason) => { if (reason) stats.reasons[reason] = (stats.reasons[reason] || 0) + 1; };
  const slugs = new Set();
  for (const row of rows) {
    stats.checked += 1;
    const tmdbId = Number(row.candidate_tmdb_id);
    const show = shows.get(tmdbId);
    if (show === undefined) { stats.errors += 1; bump('tmdb-error'); continue; }
    const input = { tmdbId, mediaType: 'tv' };
    const aiRun = row.ai_run_id ?? null;
    const decline = async (reason, extra = {}) => {
      stats.blocked += 1;
      bump(reason);
      if (apply) await record(row.id, input, reason, { evidence: { pass: PASS, ...extra, ...(aiRun ? { aiRun } : {}) } });
    };
    if (!show) { await decline('tmdb-show-missing'); continue; }
    const inferred = inferSeasonFromTmdb(row, show);
    if (inferred.season === null) { await decline(inferred.reason); continue; }
    const numberOfSeasons = Number(show.number_of_seasons) > 0 ? Number(show.number_of_seasons) : null;
    const evidence = { pass: PASS, season: inferred.season, tmdbSeason: inferred.tmdbSeason, ...(aiRun ? { aiRun } : {}) };
    const result = await assign(row.id, { ...input, numberOfSeasons, season: inferred.season }, { source: 'inferred', evidence, mode });
    if (result.action === 'planned') stats.planned += 1;
    else if (result.action === 'assigned') stats.assigned += 1;
    else if (result.action === 'merged') stats.merged += 1;
    else if (result.action === 'blocked') stats.blocked += 1;
    else if (result.action === 'conflict') stats.conflict += 1;
    if (result.reason && !['planned', 'assigned', 'merged'].includes(result.action)) bump(result.reason);
    if (result.action === 'assigned' || result.action === 'merged') {
      if (result.survivorSlug) slugs.add(result.survivorSlug);
      if (result.dropSlug) slugs.add(result.dropSlug);
    }
  }
  stats.slugs = [...slugs];
  return stats;
}

/** In-cycle memo of /tv/{id} responses (createTmdbClient's cache interface). */
class SimpleCache {
  #map = new Map();
  get(key) { return this.#map.get(key); }
  set(key, value) { this.#map.set(key, value); }
}
