/**
 * Worker pass that adopts the TMDB / IMDb ids NguonC and KKPhim publish (rules in
 * providerIdentity.js). Two steps, both worker only, never a request path, run inside syncCycle
 * (which holds catalogLock) before cache invalidation:
 *
 *  1. List walk (crawl_checkpoints lane 'provider-ids'): pages through each provider's
 *     "phim-moi-cap-nhat" list (the list items already carry tmdb/imdb) and refreshes only the
 *     identity keys of the stored source metadata. Re-walks after PROVIDER_IDS_REWALK_DAYS.
 *  2. Resolve: a keyset walk over ready rows that decides each one from its sources' claims and
 *     writes through tmdbIdentity.js (logged in tmdb_identity_changes, undoable). Every decision
 *     lands in provider_identity_reviews; an unchanged fingerprint is skipped next time.
 *
 * PROVIDER_TMDB_MODE=off|dry-run|apply; apply writes only the tiers in PROVIDER_TMDB_TIERS
 * (fill, season, overwrite, merge). Season and overwrite writes share PROVIDER_TMDB_OVERWRITE_PER_DAY.
 */
import { config } from './config.js';
import { pool } from './db.js';
import {
  AI_REVIEW_REASONS, SEASON_REVIEW_REASONS, VERIFY_REASONS, claimFromMetadata, providerYearCheck, claimsKey, decideProviderIdentity, tierEnabled, typeConflict,
  upsertIdentityView
} from './providerIdentity.js';
import { assignTmdbIdentity } from './tmdbIdentity.js';
import { createTmdbClient } from './tmdbMatchAi.js';
import { inferSeasonFromTmdb } from './tmdbSeasonInfer.js';
import { nguoncSeason } from './duplicateMerge.js';

export const LANE = 'provider-ids';
export const PASS = 'provider-ids';
export const IDENTITY_KEYS = ['tmdb_id', 'tmdb_type', 'tmdb_season', 'imdb_id'];
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// 1. List walk

/** The identity keys of a normalized record's metadata, or null when it names neither id. */
export function identityMetaOf(normalized) {
  const metadata = normalized?.metadata || {};
  if (!metadata.tmdb_id && !metadata.imdb_id) return null;
  const meta = {};
  for (const name of IDENTITY_KEYS) {
    if (metadata[name] !== null && metadata[name] !== undefined && metadata[name] !== '') meta[name] = metadata[name];
  }
  return meta;
}

/**
 * Replace the identity keys of stored source metadata by provider slug. Only rows whose metadata
 * actually changes are written; updated_at is left alone (it drives the stale-source queue).
 * A list item without a season keeps the stored season of the same tmdb id (detail records carry
 * it, list items sometimes do not), so the value does not flip between detail and list.
 */
export async function updateSourceIdentityClaims(provider, entries, { db = pool } = {}) {
  if (!entries.length) return 0;
  const result = await db.query(
    'WITH v AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(slug text, meta jsonb)), ' +
    'n AS (SELECT s.id, (COALESCE(s.metadata, \'{}\'::jsonb) - $3::text[]) || v.meta || ' +
    "  CASE WHEN NOT v.meta ? 'tmdb_season' AND s.metadata ? 'tmdb_season' AND s.metadata->'tmdb_id' = v.meta->'tmdb_id' " +
    "    AND s.metadata->'tmdb_type' IS NOT DISTINCT FROM v.meta->'tmdb_type' " +
    "  THEN jsonb_build_object('tmdb_season', s.metadata->'tmdb_season') ELSE '{}'::jsonb END AS next, s.metadata AS prev " +
    '  FROM movie_provider_sources s JOIN v ON s.provider=$1 AND s.provider_slug=v.slug) ' +
    'UPDATE movie_provider_sources s SET metadata=n.next FROM n WHERE s.id=n.id AND n.next IS DISTINCT FROM n.prev',
    [provider, JSON.stringify(entries), IDENTITY_KEYS]
  );
  return result.rowCount;
}

/**
 * Walk up to `pagesPerRun` list pages per provider. deps: providers, normalize(provider, item),
 * getCheckpoint, saveCheckpoint, recordFailure, resetCheckpoint, update, stopping(), totalPages.
 */
export async function refreshProviderIdClaims(deps) {
  const settings = deps.settings ?? config;
  const stats = { pages: 0, items: 0, updated: 0, errors: 0 };
  if (settings.providerTmdbMode === 'off' || !settings.providerIdsPagesPerRun) return stats;
  const update = deps.update ?? updateSourceIdentityClaims;
  const stopping = deps.stopping ?? (() => false);
  for (const provider of deps.providers) {
    if (stopping()) break;
    await deps.resetCheckpoint(provider.name, LANE, 1, settings.providerIdsRewalkDays * DAY_MS).catch(() => false);
    const checkpoint = await deps.getCheckpoint(provider.name, LANE, 1);
    if (checkpoint.completed_at) continue;
    let page = checkpoint.next_page;
    let pages = 0;
    try {
      while (pages < settings.providerIdsPagesPerRun && !stopping()) {
        const list = await provider.list('phim-moi-cap-nhat', page);
        const items = provider.listItems(list.data);
        const entries = [];
        for (const item of items) {
          const normalized = deps.normalize(provider, item);
          const meta = identityMetaOf(normalized);
          if (meta && normalized.providerSlug) entries.push({ slug: normalized.providerSlug, meta });
        }
        stats.items += items.length;
        stats.updated += await update(provider.name, entries);
        pages += 1;
        stats.pages += 1;
        const total = deps.totalPages(list.data);
        const completed = !items.length || Boolean(total && page >= total);
        page += 1;
        await deps.saveCheckpoint(provider.name, LANE, { nextPage: page, totalPages: total, completed });
        if (completed) break;
      }
    } catch (error) {
      stats.errors += 1;
      await deps.recordFailure(provider.name, LANE, error).catch(() => {});
      console.warn('[worker] provider ids ' + provider.name + ' page ' + page + ' failed', error.message);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// 2. Resolve

const resolveCursor = { afterId: null };

/** Ready rows in id order with their available sources' identity claims and the last review. */
export async function listProviderIdentityRows(limit, { afterId = null, db = pool } = {}) {
  const result = await db.query(
    'SELECT m.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(\'provider\', s.provider, \'meta\', ' +
    "  jsonb_build_object('tmdb_id', s.metadata->'tmdb_id', 'tmdb_type', s.metadata->'tmdb_type', " +
    "  'tmdb_season', s.metadata->'tmdb_season', 'imdb_id', s.metadata->'imdb_id')) ORDER BY s.provider, s.provider_slug) " +
    '  FROM movie_provider_sources s WHERE s.movie_id=m.id AND s.availability), \'[]\'::jsonb) AS provider_claims, ' +
    'r.claims_key AS review_key, r.status AS review_status, r.outcome AS review_outcome ' +
    'FROM movies m LEFT JOIN provider_identity_reviews r ON r.movie_id=m.id ' +
    "WHERE m.catalog_state='ready' AND ($2::uuid IS NULL OR m.id > $2::uuid) ORDER BY m.id LIMIT $1",
    [Math.max(1, Math.floor(limit)), afterId]
  );
  return result.rows;
}

/** One review row per movie; a settled ('done') row gets resolved_at. */
export async function saveProviderReview(entry, { db = pool } = {}) {
  await db.query(
    'INSERT INTO provider_identity_reviews (movie_id, claims_key, action, reason, tier, status, outcome, candidates, claims, decided_at, resolved_at) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,now(),CASE WHEN $6='done' THEN now() END) " +
    'ON CONFLICT (movie_id) DO UPDATE SET claims_key=EXCLUDED.claims_key, action=EXCLUDED.action, reason=EXCLUDED.reason, ' +
    'tier=EXCLUDED.tier, status=EXCLUDED.status, outcome=EXCLUDED.outcome, candidates=EXCLUDED.candidates, ' +
    // decided_at only moves when the decision itself changes: a new fingerprint (tiers, mode) with
    // the same queued question must not reopen a review the AI match already ranked.
    'claims=EXCLUDED.claims, resolved_at=EXCLUDED.resolved_at, decided_at=CASE WHEN ' +
    'provider_identity_reviews.status=EXCLUDED.status AND provider_identity_reviews.action=EXCLUDED.action ' +
    'AND provider_identity_reviews.reason IS NOT DISTINCT FROM EXCLUDED.reason ' +
    'AND provider_identity_reviews.candidates IS NOT DISTINCT FROM EXCLUDED.candidates ' +
    'THEN provider_identity_reviews.decided_at ELSE now() END',
    [entry.movieId, entry.key, entry.action, entry.reason ?? null, entry.tier ?? null, entry.status, entry.outcome ?? null,
      JSON.stringify(entry.candidates ?? null), JSON.stringify(entry.claims ?? null)]
  );
}

/** Season/overwrite writes and merges (any tier) the provider pass made today (UTC), for the daily cap. */
export async function countProviderOverwritesToday({ db = pool } = {}) {
  const result = await db.query(
    "SELECT count(*)::int AS n FROM tmdb_identity_changes WHERE source='provider' AND evidence->>'pass'=$1 " +
    "AND (kind='merge' OR (kind='assign' AND evidence->>'tier' IN ('season','overwrite'))) " +
    "AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    [PASS]
  );
  return result.rows[0]?.n ?? 0;
}

/** Fill an empty imdb_id unless another season-less row of the same family holds it. */
export async function fillImdbId(row, imdbId, { db = pool } = {}) {
  const result = await db.query(
    'UPDATE movies m SET imdb_id=$2, updated_at=now() WHERE m.id=$1 AND m.imdb_id IS NULL AND (m.tmdb_season_number IS NOT NULL OR NOT EXISTS ' +
    '(SELECT 1 FROM movies o WHERE o.imdb_id=$2 AND o.media_type=m.media_type AND o.tmdb_season_number IS NULL AND o.id<>m.id))',
    [row.id, imdbId]
  );
  return result.rowCount > 0;
}

function settingsFingerprint(settings) {
  return settings.providerTmdbMode + ':' + [...(settings.providerTmdbTiers || [])].sort().join(',');
}

/** What the decision depends on: claims, the row's own identity, the pin and the mode/tiers. */
export function reviewFingerprint(row, claims, settings) {
  return claimsKey(claims) + '#' + [row.tmdb_id ?? '', row.tmdb_media_type ?? '', row.tmdb_season_number ?? '',
    row.imdb_id ?? '', row.tmdb_identity_pinned === true ? 'p' : '', settingsFingerprint(settings)].join(':');
}

/** Skip a row whose fingerprint is unchanged, or one the AI match settled on the same claims. */
export function reviewUnchanged(row, fingerprint) {
  if (!row.review_key) return false;
  if (row.review_key === fingerprint) return true;
  const claimsPart = fingerprint.slice(0, fingerprint.indexOf('#') + 1);
  return row.review_status === 'done' && String(row.review_outcome || '').startsWith('ai-') && row.review_key.startsWith(claimsPart);
}

function claimsOf(row) {
  const list = Array.isArray(row.provider_claims) ? row.provider_claims : [];
  return list.map((entry) => claimFromMetadata(entry.provider, entry.meta));
}

/** Season of a tv id with no season anywhere: one TMDB season, else the season inference. */
export function seasonFromShow(row, show) {
  const marker = nguoncSeason(row);
  if (marker) return { season: marker };
  if (!show) return { season: null, reason: 'tmdb-show-missing' };
  if (Number(show.number_of_seasons) === 1) return { season: 1 };
  const inferred = inferSeasonFromTmdb(row, show);
  return inferred.season ? { season: inferred.season } : { season: null, reason: inferred.reason || 'season-unresolved' };
}

/** A /find result naming exactly one movie or tv title. */
export function pickFindResult(body) {
  const movies = Array.isArray(body?.movie_results) ? body.movie_results : [];
  const shows = Array.isArray(body?.tv_results) ? body.tv_results : [];
  if (movies.length + shows.length !== 1) return null;
  const hit = movies[0] || shows[0];
  const id = Number(hit?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { id, mediaType: movies.length ? 'movie' : 'tv' };
}

/**
 * One resolve batch. deps (tests): settings, list, assign, save, countOverwrites, fillImdb, client.
 * Returns stats with `slugs` (survivor and dropped slugs of every write) for cache invalidation.
 */
export async function resolveProviderIdentities(deps = {}) {
  const settings = deps.settings ?? config;
  const mode = settings.providerTmdbMode;
  const stats = {
    mode, checked: 0, skipped: 0, assigned: 0, merged: 0, planned: 0, queued: 0, blocked: 0, conflict: 0,
    noop: 0, imdbFilled: 0, lookups: 0, capped: 0, errors: 0, reasons: {}, slugs: []
  };
  if (mode === 'off') return stats;
  const list = deps.list ?? listProviderIdentityRows;
  const assign = deps.assign ?? assignTmdbIdentity;
  const saveReview = deps.save ?? saveProviderReview;
  const fillImdb = deps.fillImdb ?? fillImdbId;
  const apply = mode === 'apply';
  const rows = await list(settings.providerTmdbBatch, { afterId: resolveCursor.afterId });
  resolveCursor.afterId = rows.length >= settings.providerTmdbBatch ? rows[rows.length - 1].id : null;
  if (!rows.length) return stats;

  const tmdbReady = Boolean(deps.client) || Boolean(settings.tmdbEnabled !== false && settings.tmdbApiKey);
  let client = deps.client ?? null;
  const tmdb = async (path) => {
    if (!tmdbReady) return undefined;
    if (stats.lookups >= settings.providerTmdbLookupsPerCycle) return undefined;
    stats.lookups += 1;
    client ??= createTmdbClient({ concurrency: 2 });
    try { return await client.get(path, { language: '' }); } catch { stats.errors += 1; return undefined; }
  };
  let overwrites = apply ? await (deps.countOverwrites ?? countProviderOverwritesToday)().catch(() => 0) : 0;
  const bump = (reason) => { if (reason) stats.reasons[reason] = (stats.reasons[reason] || 0) + 1; };
  const slugs = new Set();

  for (const row of rows) {
    const claims = claimsOf(row);
    const fingerprint = reviewFingerprint(row, claims, settings);
    if (reviewUnchanged(row, fingerprint)) { stats.skipped += 1; continue; }
    stats.checked += 1;
    let decision = decideProviderIdentity({ row, claims });
    const review = { movieId: row.id, key: fingerprint, claims: claims.filter((claim) => claim.tmdbId || claim.imdbId) };
    // The stored key describes the row as it is after this decision's writes, so a row is not
    // decided a second time only because its own imdb/tmdb columns were just filled.
    let current = row;
    const save = (entry) => saveReview({ ...entry, key: reviewFingerprint(current, claims, settings) });
    let lookupMissed = false;
    let showBody;

    if (decision.action === 'find') {
      const body = await tmdb('/find/' + decision.imdbId + '?external_source=imdb_id');
      if (body === undefined) lookupMissed = true;
      const hit = body ? pickFindResult(body) : null;
      if (hit && typeConflict(row, hit.mediaType)) {
        decision = { ...decision, action: 'blocked', reason: 'find-type-mismatch', candidates: [{ id: hit.id, type: hit.mediaType }] };
      } else if (hit) {
        decision = hit.mediaType === 'tv'
          ? { ...decision, action: 'resolve-season', tier: 'fill', identity: { id: hit.id, mediaType: 'tv', season: null }, reason: 'imdb-find' }
          : { ...decision, action: 'assign', tier: 'fill', identity: { id: hit.id, mediaType: 'movie', season: null }, reason: 'imdb-find' };
      } else if (body !== undefined) {
        decision = { ...decision, action: 'none', reason: 'find-no-unique-result' };
      }
    }

    if (decision.action === 'resolve-season') {
      const show = await tmdb('/tv/' + decision.identity.id);
      showBody = show;
      if (show === undefined) lookupMissed = true;
      else {
        const found = seasonFromShow(row, show);
        decision = found.season
          ? { ...decision, action: 'assign', identity: { ...decision.identity, season: found.season }, seasonFrom: 'tmdb' }
          : { ...decision, action: 'queue', reason: 'season-unresolved', detail: found.reason, candidates: [{ id: decision.identity.id, type: 'tv' }] };
      }
    }

    // One provider's word for an empty row (or a held id with no season): the TMDB title must exist
    // and fit the row's year, otherwise the id goes to the AI match as a candidate instead.
    if (decision.action === 'assign' && VERIFY_REASONS.has(decision.reason) && settings.providerTmdbVerify !== false) {
      const { id, mediaType } = decision.identity;
      const body = mediaType === 'tv' && showBody !== undefined ? showBody : await tmdb('/' + mediaType + '/' + id);
      if (body === undefined) lookupMissed = true;
      else {
        const why = providerYearCheck(row, decision.identity, body);
        if (why) decision = { ...decision, action: 'queue', reason: 'provider-unverified', detail: why, candidates: [{ id, type: mediaType }] };
      }
    }

    // imdb: fill only, never overwrite; conflicts are reported in the review, not in tmdb_identity_changes.
    let imdbOutcome = null;
    if (decision.imdb?.action === 'fill' && !row.imdb_id) {
      if (tierEnabled(settings, 'fill')) {
        imdbOutcome = await fillImdb(row, decision.imdb.imdbId).catch(() => false) ? 'imdb-filled' : 'imdb-taken';
        if (imdbOutcome === 'imdb-filled') { stats.imdbFilled += 1; slugs.add(row.canonical_slug); current = { ...current, imdb_id: decision.imdb.imdbId }; }
      } else imdbOutcome = 'imdb-planned';
    } else if (decision.imdb?.action === 'conflict') imdbOutcome = 'imdb-conflict';

    const withImdb = (outcome) => [outcome, imdbOutcome].filter(Boolean).join(';') || null;

    if (lookupMissed) {
      // TMDB budget or error: leave no fingerprint so the row is decided again next walk.
      stats.capped += 1;
      bump('lookup-deferred');
      continue;
    }

    if (decision.action === 'assign') {
      const tier = decision.tier;
      const capped = tier === 'season' || tier === 'overwrite';
      const enabled = tierEnabled(settings, tier);
      const overCap = apply && enabled && capped && overwrites >= settings.providerTmdbOverwritePerDay;
      // A merge (any tier) deletes a row: it shares the daily cap with season/overwrite writes.
      const mergeOn = tierEnabled(settings, 'merge');
      const mergeCapped = apply && enabled && mergeOn && overwrites >= settings.providerTmdbOverwritePerDay;
      if (overCap) {
        stats.capped += 1;
        bump('daily-cap');
        continue; // no fingerprint: retried tomorrow
      }
      const evidence = { pass: PASS, tier, reason: decision.reason, claims: review.claims, ...(decision.seasonFrom ? { seasonFrom: decision.seasonFrom } : {}) };
      const result = await assign(row.id, {
        tmdbId: decision.identity.id, mediaType: decision.identity.mediaType, season: decision.identity.season ?? null
      }, {
        source: 'provider', evidence, mode: apply && enabled ? 'apply' : 'dry-run', reason: 'provider:' + decision.reason,
        replace: row.tmdb_id !== null && row.tmdb_id !== undefined, guard: true, respectPin: true,
        allowMerge: mergeOn && !mergeCapped
      }).catch((error) => ({ action: 'error', reason: error.message }));
      if (mergeCapped && result.reason === 'merge-disabled') {
        stats.capped += 1;
        bump('daily-cap');
        continue; // the merge waits for tomorrow's cap, no fingerprint
      }
      const base = { ...review, action: 'assign', reason: decision.reason, tier, candidates: decision.candidates ?? null };
      if (result.action === 'assigned' || result.action === 'merged') {
        stats[result.action] += 1;
        if (capped || result.action === 'merged') overwrites += 1;
        if (result.survivorSlug) slugs.add(result.survivorSlug);
        if (result.dropSlug) slugs.add(result.dropSlug);
        // The merge kept the holder and deleted this row: its review row would break the foreign key.
        // The survivor's own review is re-decided on its next turn (its identity columns changed).
        if (result.action === 'merged' && result.dropId === row.id) continue;
        current = { ...current, tmdb_id: decision.identity.id, tmdb_media_type: decision.identity.mediaType,
          tmdb_season_number: result.season ?? decision.identity.season ?? null };
        await save({ ...base, status: 'done', outcome: withImdb(result.action) });
      } else if (result.action === 'planned') {
        stats.planned += 1;
        await save({ ...base, status: 'planned', outcome: withImdb('would-' + (result.plan === 'merge' ? 'merge' : 'assign') + (result.dropSlug ? ':' + result.dropSlug : '')) });
      } else if (result.action === 'noop') {
        stats.noop += 1;
        await save({ ...base, status: 'done', outcome: withImdb('noop') });
      } else if (result.action === 'error') {
        stats.errors += 1;
        bump('error');
      } else {
        // blocked / conflict: merge-disabled waits for the merge tier, so it is 'planned'.
        const mergeWait = result.reason === 'merge-disabled';
        stats[mergeWait ? 'planned' : result.action === 'conflict' ? 'conflict' : 'blocked'] += 1;
        bump(result.reason);
        await save({
          ...base, status: mergeWait ? 'planned' : 'blocked',
          outcome: withImdb((mergeWait ? 'would-merge:' + (result.holderSlug || '') : result.reason) || result.action)
        });
      }
      continue;
    }

    if (decision.action === 'queue') {
      stats.queued += 1;
      bump(decision.reason);
      const pendingFor = AI_REVIEW_REASONS.has(decision.reason) || SEASON_REVIEW_REASONS.has(decision.reason);
      await save({
        ...review, action: 'queue', reason: decision.reason, tier: null,
        status: pendingFor ? 'pending' : 'blocked',
        outcome: withImdb(decision.detail ?? (decision.seasons ? 'seasons:' + decision.seasons.join(',') : null)),
        candidates: decision.candidates ?? null
      });
      continue;
    }

    if (decision.action === 'blocked') {
      stats.blocked += 1;
      bump(decision.reason);
      await save({ ...review, action: 'blocked', reason: decision.reason, status: 'blocked', outcome: withImdb(null), candidates: decision.candidates ?? null });
      continue;
    }

    stats.noop += 1;
    await save({ ...review, action: decision.action, reason: decision.reason ?? null, status: imdbOutcome === 'imdb-planned' ? 'planned' : 'done', outcome: withImdb(null) });
  }
  stats.slugs = [...slugs];
  return stats;
}

export function formatProviderIdentityStats(walk, resolved) {
  return '[worker] provider ids mode=' + resolved.mode + ' pages=' + walk.pages + ' items=' + walk.items + ' claimsUpdated=' + walk.updated +
    ' checked=' + resolved.checked + ' skipped=' + resolved.skipped + ' assigned=' + resolved.assigned + ' merged=' + resolved.merged +
    ' planned=' + resolved.planned + ' queued=' + resolved.queued + ' blocked=' + resolved.blocked + ' conflict=' + resolved.conflict +
    ' imdbFilled=' + resolved.imdbFilled + ' lookups=' + resolved.lookups + ' deferred=' + resolved.capped +
    ' errors=' + (walk.errors + resolved.errors) + ' reasons=' + JSON.stringify(resolved.reasons);
}

/** Test hook. */
export function resetProviderIdentityCursor() {
  resolveCursor.afterId = null;
}

// ---------------------------------------------------------------------------------------------
// 3. Upsert guard

/**
 * Year check for the ids the sync upsert would write straight into an empty row (the one write path
 * that does not go through resolveProviderIdentities). Called by the worker before upsertCanonical,
 * never inside its transaction. Returns the record unchanged when nothing would be filled or the TMDB
 * title fits the row's year; otherwise the record without its TMDB tuple, so upsert fills nothing and
 * providerIdentitySync later decides it (the ids stay in the source metadata). A missing key, an
 * exhausted per-cycle budget or a failed lookup also strip the tuple: unverified ids are never written.
 * One TMDB lookup per row that is about to be filled, cached by title for the process.
 */
export function createUpsertIdentityGuard({ settings = config, db = pool, client = null } = {}) {
  const budget = Math.max(0, settings.providerTmdbLookupsPerCycle ?? 0);
  const cache = new Map();
  let used = 0;
  let tmdb = client;
  const strip = (record) => ({ ...record, tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null });

  const guard = async (incoming) => {
    if (settings.providerTmdbVerify === false) return incoming;
    const view = upsertIdentityView(incoming, settings);
    const id = Number(view.tmdbId);
    const mediaType = view.tmdbMediaType;
    if (!Number.isSafeInteger(id) || id <= 0 || !['movie', 'tv'].includes(mediaType)) return incoming;
    const season = mediaType === 'tv' ? Number(view.tmdbSeasonNumber) : null;
    if (mediaType === 'tv' && !(Number.isInteger(season) && season >= 1)) return incoming; // upsert fills no tuple without a season

    const existing = (await db.query(
      'SELECT m.year, m.tmdb_id, m.tmdb_media_type, m.tmdb_season_number, m.tmdb_identity_pinned FROM movie_provider_sources s ' +
      'JOIN movies m ON m.id=s.movie_id WHERE s.provider=$1 AND s.provider_slug=$2 LIMIT 1',
      [incoming.provider, incoming.providerSlug]
    ).catch(() => ({ rows: [] }))).rows[0];
    if (existing) {
      if (existing.tmdb_identity_pinned === true) return incoming;
      const empty = existing.tmdb_id === null || existing.tmdb_id === undefined;
      const seasonFill = !empty && mediaType === 'tv' && Number(existing.tmdb_id) === id && existing.tmdb_media_type === 'tv' &&
        (existing.tmdb_season_number === null || existing.tmdb_season_number === undefined);
      if (!empty && !seasonFill) return incoming; // a held tuple is never replaced here
    }
    const year = existing?.year ?? incoming.year;
    const key = mediaType + ':' + id;
    let body = cache.get(key);
    if (body === undefined) {
      const ready = Boolean(tmdb) || Boolean(settings.tmdbEnabled !== false && settings.tmdbApiKey);
      if (!ready || used >= budget) return strip(incoming);
      used += 1;
      tmdb ??= createTmdbClient({ concurrency: 2 });
      try { body = await tmdb.get('/' + mediaType + '/' + id, { language: '' }); } catch { return strip(incoming); }
      if (body === undefined) return strip(incoming);
      cache.set(key, body ?? null);
    }
    return providerYearCheck({ year }, { id, mediaType, season }, body) ? strip(incoming) : incoming;
  };
  guard.resetBudget = () => { used = 0; cache.clear(); };
  return guard;
}
