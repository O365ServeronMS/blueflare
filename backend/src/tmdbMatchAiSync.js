import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { mapLimit } from './concurrency.js';
import { createTmdbMatchRotation, tmdbMatchAiAvailable, MatchBlockedError, MatchContentError } from './tmdbMatchGemini.js';
import { collectAiCandidates, createTmdbClient, decideAiMatch, matchInput, promptEntry, rankBatch } from './tmdbMatchAi.js';

/**
 * Worker pass: rank real TMDB candidates with Gemini, let the independent gate
 * (decideAiMatch) decide, record every verdict in tmdb_match_ai_runs, and in
 * `apply` mode hand verified picks to assignTmdbIdentity. Never on a request path.
 * Free-tier quota makes this slow on purpose: a cycle stops cleanly when the
 * rotation reports blocked and the untouched titles are picked up next cycle.
 */

const RUN_STATUS = { verified: 'chosen', unverifiable: 'rejected', none: 'rejected', error: 'error' };
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

const shared = { rotation: null, blockedUntil: 0, state: {} };

/**
 * Titles still without an identity that have no recent AI run. A recent run is one
 * newer than retryMs (errorRetryMs for 'error'). In apply mode a dry-run 'verified'
 * run does not count: those titles must be re-examined once so they can be applied.
 * Rows with a cast of two or more go first (the gate is strongest there).
 */
export async function listAiMatchCandidates({ mode, limit, retryMs, errorRetryMs }) {
  const result = await pool.query(
    'SELECT m.id, m.canonical_slug, m.title, m.original_title, m.year, m.media_type, m.display_type, ' +
    'm.countries, m.actors, m.episode_total, m.duration, m.overview FROM movies m ' +
    "WHERE m.catalog_state='ready' AND m.tmdb_id IS NULL " +
    "  AND m.tmdb_match_status IS DISTINCT FROM 'verified' " +
    "  AND COALESCE(m.original_title, '') <> '' " +
    '  AND NOT EXISTS (SELECT 1 FROM tmdb_match_ai_runs r WHERE r.movie_id = m.id ' +
    "    AND r.created_at > now() - (CASE WHEN r.outcome = 'error' THEN $2::bigint ELSE $1::bigint END) * interval '1 millisecond' " +
    "    AND ($3::text = 'dry-run' OR r.mode = 'apply' OR r.outcome IS DISTINCT FROM 'verified')) " +
    "ORDER BY (jsonb_typeof(m.actors) = 'array' AND jsonb_array_length(m.actors) >= 2) DESC, " +
    'm.catalog_sort_at DESC NULLS LAST LIMIT $4',
    [retryMs, errorRetryMs, mode, Math.max(1, Math.floor(limit))]
  );
  return result.rows;
}

const compactForStore = (candidates) => candidates.map((c) => ({
  key: c.key, title: c.title, originalTitle: c.originalTitle, year: c.year, type: c.type
}));

export async function recordAiRun(run) {
  await pool.query(
    'INSERT INTO tmdb_match_ai_runs (run_id, mode, movie_id, candidates, chosen_tmdb_id, media_type, confidence, evidence, status, outcome, model) ' +
    'VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, $11) ON CONFLICT (run_id, movie_id) DO NOTHING',
    [
      run.runId, run.mode, run.movieId, JSON.stringify(run.candidates ?? []), run.chosenTmdbId ?? null,
      run.mediaType ?? null, run.confidence ?? null, JSON.stringify(run.evidence ?? {}), run.status, run.outcome, run.model ?? null
    ]
  );
}

async function resolveAssign(deps) {
  if (deps.assign) return deps.assign;
  const module = await (deps.loadIdentity ?? (() => import('./tmdbIdentity.js')))();
  if (typeof module.assignTmdbIdentity !== 'function') throw new Error('tmdbIdentity.assignTmdbIdentity is missing');
  return module.assignTmdbIdentity;
}

/** Returns canonical slugs whose detail payload changed (apply mode only). */
export async function refreshTmdbAiMatches(deps = {}) {
  const settings = deps.config ?? config;
  const mode = settings.tmdbMatchAiMode;
  if (mode === 'off' || !tmdbMatchAiAvailable(settings) || !settings.tmdbEnabled || !settings.tmdbApiKey) return [];
  const now = deps.now ?? (() => Date.now());
  const state = deps.state ?? shared;
  if (now() < (state.blockedUntil ?? 0)) return [];
  const log = deps.log ?? ((message) => console.log(message));
  const warn = deps.warn ?? ((message) => console.warn(message));

  let assign = null;
  if (mode === 'apply') {
    try { assign = await resolveAssign(deps); } catch (error) {
      warn('[worker] tmdb ai match: apply mode but identity assignment is unavailable (' + error.message + '), pass skipped');
      return [];
    }
  }

  const list = deps.list ?? listAiMatchCandidates;
  const record = deps.record ?? recordAiRun;
  const rows = await list({
    mode, limit: settings.tmdbMatchAiLimit, retryMs: settings.tmdbMatchAiRetryMs, errorRetryMs: settings.tmdbMatchAiErrorRetryMs
  });
  if (!rows.length) return [];

  const rotation = deps.rotation ?? (state.rotation ??= createTmdbMatchRotation(settings, { now: deps.rotationNow, warn: deps.rotationWarn }));
  const client = deps.client ?? createTmdbClient({ concurrency: Math.min(4, settings.tmdbMatchConcurrency ?? 2) });
  const runId = (deps.randomUUID ?? randomUUID)();
  const counts = { checked: 0, verified: 0, unverifiable: 0, none: 0, error: 0, merged: 0, assigned: 0 };
  const models = new Map();
  const changed = [];
  let blocked = null;

  const finish = async (row, input, candidates, decision, model) => {
    counts.checked += 1;
    counts[decision.status] += 1;
    const pick = decision.pick ?? null;
    const evidence = { tier: decision.tier ?? null, reason: decision.reason ?? null, ...decision.evidence };
    let status = RUN_STATUS[decision.status];
    if (decision.status === 'verified' && mode === 'apply') {
      try {
        const result = await assign(row.id, { tmdbId: pick.id, mediaType: pick.type, numberOfSeasons: pick.seasons ?? null }, { source: 'inferred', evidence: { ...evidence, candidate: pick.key, model, aiRun: runId } });
        evidence.action = result?.action ?? null;
        if (result?.reason) evidence.actionReason = result.reason;
        if (result?.action === 'assigned' || result?.action === 'merged' || result?.action === 'noop') status = 'applied';
        else status = 'skipped';
        if (result?.action === 'assigned') counts.assigned += 1;
        if (result?.action === 'merged') counts.merged += 1;
        if (result?.action === 'assigned' || result?.action === 'merged') {
          for (const slug of [result.survivorSlug, result.droppedSlug]) if (slug) changed.push(slug);
        }
      } catch (error) {
        status = 'error';
        evidence.error = String(error.message).slice(0, 300);
        warn('[worker] tmdb ai match assign failed for ' + row.canonical_slug + ': ' + evidence.error);
      }
    }
    if (decision.status === 'error') evidence.error = decision.reason;
    await record({
      runId, mode, movieId: row.id, candidates: compactForStore(candidates), chosenTmdbId: pick?.id, mediaType: pick?.type,
      confidence: evidence.confidence ?? null, evidence, status,
      outcome: status === 'error' && decision.status === 'verified' ? 'error' : decision.status, model
    }).catch((error) => warn('[worker] tmdb ai match could not record run for ' + row.canonical_slug + ': ' + error.message));
  };
  const failure = (reason) => ({ status: 'error', pick: null, reason, evidence: {} });

  const batchSize = Math.max(1, settings.tmdbMatchGeminiBatch ?? 10);
  let consecutiveFailures = 0;
  for (let start = 0; start < rows.length && !blocked; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    // TMDB lookups first (no Gemini quota); a lookup failure only fails that title.
    const prepared = await mapLimit(batch, Math.min(4, settings.tmdbMatchConcurrency ?? 2), async (row) => {
      const input = matchInput(row);
      try {
        const { candidates } = await collectAiCandidates(input, client);
        return { row, input, candidates };
      } catch (error) {
        return { row, input, candidates: [], failed: String(error.message).slice(0, 200) };
      }
    });
    const ranked = [];
    for (const item of prepared) {
      if (item.failed) await finish(item.row, item.input, [], failure('tmdb: ' + item.failed), null);
      else if (!item.candidates.length) await finish(item.row, item.input, [], decideAiMatch({ input: item.input, candidates: [], choice: undefined }), null);
      else ranked.push(item);
    }
    if (!ranked.length) continue;

    const rankGroup = async (group) => {
      const entries = group.map((item, index) => promptEntry('m' + index, item.input, item.candidates));
      const meta = {};
      const choices = await rankBatch(rotation, entries, undefined, meta);
      if (meta.model) models.set(meta.model + '@' + meta.key, (models.get(meta.model + '@' + meta.key) ?? 0) + 1);
      for (const [index, item] of group.entries()) {
        const decision = decideAiMatch({ input: item.input, candidates: item.candidates, choice: choices.get('m' + index) });
        await finish(item.row, item.input, item.candidates, decision, meta.model ?? null);
      }
    };
    const isBlocked = (error) => error instanceof MatchBlockedError || error?.blocked === true;
    try {
      await rankGroup(ranked);
      consecutiveFailures = 0;
    } catch (error) {
      if (isBlocked(error)) { blocked = error; break; }
      if (error instanceof MatchContentError && ranked.length > 1) {
        // One title may be what the model refused: isolate it with single-title calls.
        for (const item of ranked) {
          try { await rankGroup([item]); } catch (single) {
            if (isBlocked(single)) { blocked = single; break; }
            await finish(item.row, item.input, item.candidates, failure(single instanceof MatchContentError ? 'model-refused' : 'rank-failed'), null);
          }
        }
        consecutiveFailures = 0;
      } else {
        for (const item of ranked) await finish(item.row, item.input, item.candidates, failure(error instanceof MatchContentError ? 'model-refused' : 'rank-failed'), null);
        consecutiveFailures += 1;
        warn('[worker] tmdb ai match batch failed: ' + String(error.message).slice(0, 200));
        if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) break;
      }
    }
  }

  if (blocked) {
    state.blockedUntil = now() + (blocked.retryAfterMs ?? 60000);
    log('[worker] tmdb ai match: AI quota exhausted, resuming next cycle');
  }
  const used = [...models].map(([name, n]) => name + 'x' + n).join(',') || 'none';
  log('[worker] tmdb ai match mode=' + mode + ' checked=' + counts.checked + ' verified=' + counts.verified +
    ' unverifiable=' + counts.unverifiable + ' none=' + counts.none + ' error=' + counts.error +
    ' merged=' + counts.merged + ' assigned=' + counts.assigned + ' models=' + used);
  return [...new Set(changed)];
}
