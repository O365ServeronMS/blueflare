import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { mapLimit } from './concurrency.js';
import { createTmdbMatchRotation, tmdbMatchAiAvailable, MatchBlockedError, MatchContentError } from './tmdbMatchGemini.js';
import { createQuotaLedger } from './geminiQuotaLedger.js';
import { createPgQuotaStore } from './geminiQuotaStore.js';
import {
  RANK_PROMPT_OVERHEAD_CHARS, calibrateTokens, catalogFacts, collectAiCandidates, createTmdbClient, createTokenCalibration,
  decideAiMatch, DEFAULT_AI_POLICY, estimateTokens, matchInput, promptEntry, rankBatch
} from './tmdbMatchAi.js';

/**
 * Worker pass: rank real TMDB candidates with Gemini, let the independent gate
 * (decideAiMatch) decide, record every verdict in tmdb_match_ai_runs, and in
 * `apply` mode hand verified picks to assignTmdbIdentity. Never on a request path.
 *
 * `runAiMatchPass` is the engine. Films are packed into requests by estimated prompt
 * tokens (not a fixed count), a request the model refuses is bisected, and the quota
 * ledger inside the rotation decides which key+model may answer. A pass stops cleanly
 * when the rotation reports blocked; untouched titles are picked up next time.
 * The background loop (tmdbMatchAiLoop.js) calls it once per tick; `refreshTmdbAiMatches`
 * is the older whole-pass-in-the-sync-cycle entry, used only with TMDB_MATCH_AI_LOOP=false.
 */

const RUN_STATUS = { verified: 'chosen', unverifiable: 'rejected', none: 'rejected', error: 'error' };
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;
const DEFAULT_BATCH_TOKENS = 40000;
const DEFAULT_BATCH_MAX = 40;

const shared = { rotation: null, blockedUntil: 0, calibration: createTokenCalibration(), state: {} };

/**
 * Titles still without an identity that have no recent AI run. A recent run is one
 * newer than retryMs (errorRetryMs for 'error'). In apply mode a dry-run 'verified'
 * run does not count: those titles must be re-examined once so they can be applied.
 * Rows with a cast of two or more go first (the gate is strongest there).
 * scope 'priority' keeps only films first seen within freshMs and films whose last run
 * errored (the retries): the share of the daily quota that the old backlog may not touch.
 */
export async function listAiMatchCandidates({ mode, limit, retryMs, errorRetryMs, scope = 'all', freshMs = 0 }) {
  const params = [retryMs, errorRetryMs, mode, Math.max(1, Math.floor(limit))];
  let priority = '';
  if (scope === 'priority') {
    params.push(Math.max(1, Math.floor(freshMs)));
    priority = "  AND (m.created_at > now() - $5::bigint * interval '1 millisecond' " +
      "    OR EXISTS (SELECT 1 FROM tmdb_match_ai_runs e WHERE e.movie_id = m.id AND e.outcome = 'error')) ";
  }
  const result = await pool.query(
    'SELECT m.id, m.canonical_slug, m.title, m.original_title, m.year, m.media_type, m.display_type, ' +
    'm.countries, m.actors, m.episode_total, m.duration, m.overview FROM movies m ' +
    "WHERE m.catalog_state='ready' AND m.tmdb_id IS NULL " +
    "  AND m.tmdb_match_status IS DISTINCT FROM 'verified' " +
    "  AND COALESCE(m.original_title, '') <> '' " +
    '  AND NOT EXISTS (SELECT 1 FROM tmdb_match_ai_runs r WHERE r.movie_id = m.id ' +
    "    AND r.created_at > now() - (CASE WHEN r.outcome = 'error' THEN $2::bigint ELSE $1::bigint END) * interval '1 millisecond' " +
    "    AND ($3::text = 'dry-run' OR r.mode = 'apply' OR r.outcome IS DISTINCT FROM 'verified')) " +
    priority +
    "ORDER BY (jsonb_typeof(m.actors) = 'array' AND jsonb_array_length(m.actors) >= 2) DESC, " +
    'm.catalog_sort_at DESC NULLS LAST LIMIT $4',
    params
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

/** The pass can run at all: mode, own Gemini keys, TMDB. */
export function aiPassAvailable(settings = config) {
  return settings.tmdbMatchAiMode !== 'off' && tmdbMatchAiAvailable(settings) && Boolean(settings.tmdbEnabled) && Boolean(settings.tmdbApiKey);
}

/** The process-wide rotation (own state, ledger backed by PostgreSQL). Tests inject `deps.rotation` instead. */
export function sharedAiRotation(settings = config, deps = {}) {
  const state = deps.state ?? shared;
  return state.rotation ??= createTmdbMatchRotation(settings, {
    now: deps.rotationNow, warn: deps.rotationWarn, signal: deps.signal,
    ledger: deps.ledger ?? createQuotaLedger({ store: createPgQuotaStore(), now: deps.rotationNow, warn: deps.rotationWarn })
  });
}

const tierOf = (input) => (catalogFacts(input).actorCount >= DEFAULT_AI_POLICY.minCatalogActors ? 1 : 2);

/**
 * One pass over a listing. Options: `scope` ('all'|'priority'), `rowLimit`, `maxPacks` (requests
 * worth of films to rank; bisection retries are extra and bounded by log2). Returns
 * `{ changed, listed, requests, blocked, counts, skipped }`.
 */
export async function runAiMatchPass(deps = {}, options = {}) {
  const settings = deps.config ?? config;
  const mode = settings.tmdbMatchAiMode;
  const out = { changed: [], listed: 0, requests: 0, blocked: null, skipped: null, counts: { checked: 0, verified: 0, unverifiable: 0, none: 0, error: 0, merged: 0, assigned: 0 } };
  if (!aiPassAvailable(settings)) { out.skipped = 'unavailable'; return out; }
  const state = deps.state ?? shared;
  const log = deps.log ?? ((message) => console.log(message));
  const warn = deps.warn ?? ((message) => console.warn(message));
  const isStopping = deps.isStopping ?? (() => false);

  let assign = null;
  if (mode === 'apply') {
    try { assign = await resolveAssign(deps); } catch (error) {
      warn('[worker] tmdb ai match: apply mode but identity assignment is unavailable (' + error.message + '), pass skipped');
      out.skipped = 'no-assign';
      return out;
    }
  }

  const batchMax = Math.max(1, settings.tmdbMatchGeminiBatchMax ?? DEFAULT_BATCH_MAX);
  const batchTokens = Math.max(1000, settings.tmdbMatchGeminiBatchTokens ?? DEFAULT_BATCH_TOKENS);
  const conc = Math.min(4, settings.tmdbMatchConcurrency ?? 2);
  const list = deps.list ?? listAiMatchCandidates;
  const record = deps.record ?? recordAiRun;
  const rows = await list({
    mode, limit: options.rowLimit ?? settings.tmdbMatchAiLimit, retryMs: settings.tmdbMatchAiRetryMs, errorRetryMs: settings.tmdbMatchAiErrorRetryMs,
    scope: options.scope ?? 'all', freshMs: settings.tmdbMatchAiFreshMs
  });
  out.listed = rows.length;
  if (!rows.length) return out;

  const rotation = deps.rotation ?? sharedAiRotation(settings, { ...deps, state });
  const client = deps.client ?? createTmdbClient({ concurrency: conc });
  const calibration = state.calibration ??= createTokenCalibration();
  const runId = (deps.randomUUID ?? randomUUID)();
  const counts = out.counts;
  const models = new Map();
  const changed = [];
  const usage = { prompt: 0, output: 0, thoughts: 0 };

  const finish = async (row, candidates, decision, model) => {
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

  // ---- packing ---------------------------------------------------------------------------
  const sizeOf = (item, level) => JSON.stringify(promptEntry('m00', item.input, item.candidates, level)).length + 1;
  const tokensFor = (chars) => estimateTokens(calibration, RANK_PROMPT_OVERHEAD_CHARS + chars);
  let cursor = 0;
  const carry = [];

  // Collect TMDB evidence a few rows at a time; rows that need no model are finished on the spot.
  const refill = async () => {
    const chunk = rows.slice(cursor, cursor + conc);
    cursor += chunk.length;
    const prepared = await mapLimit(chunk, conc, async (row) => {
      const input = matchInput(row);
      try {
        const { candidates } = await collectAiCandidates(input, client);
        return { row, input, candidates };
      } catch (error) {
        return { row, input, candidates: [], failed: String(error.message).slice(0, 200) };
      }
    });
    for (const item of prepared) {
      if (item.failed) await finish(item.row, [], failure('tmdb: ' + item.failed), null);
      else if (!item.candidates.length) await finish(item.row, [], decideAiMatch({ input: item.input, candidates: [], choice: undefined }), null);
      else {
        item.tier = tierOf(item.input);
        // Rich prompts while they fit comfortably; a single huge film falls back to the compact one.
        item.level = tokensFor(sizeOf(item, 'rich')) <= batchTokens / 2 ? 'rich' : 'compact';
        item.chars = sizeOf(item, item.level);
        carry.push(item);
      }
    }
  };

  const nextPack = async () => {
    const pack = [];
    let chars = 0;
    for (;;) {
      if (!carry.length) {
        if (cursor >= rows.length) break;
        await refill();
        continue;
      }
      const item = carry[0];
      if (pack.length) {
        if (item.tier !== pack[0].tier || pack.length >= batchMax || tokensFor(chars + item.chars) > batchTokens) break;
      }
      pack.push(carry.shift());
      chars += item.chars;
    }
    return pack;
  };

  // ---- ranking with bisection --------------------------------------------------------------
  const isBlocked = (error) => error instanceof MatchBlockedError || error?.blocked === true;
  let blocked = null;
  let consecutiveFailures = 0;

  const rankGroup = async (group) => {
    const entries = group.map((item, index) => promptEntry('m' + index, item.input, item.candidates, item.level));
    const chars = entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 1, 0);
    const meta = {};
    out.requests += 1;
    const think = group[0].tier === 2 ? settings.tmdbMatchGeminiThinkT2 : settings.tmdbMatchGeminiThinkT1;
    try {
      const choices = await rankBatch(rotation, entries, undefined, meta, { tokens: tokensFor(chars), thinkingBudget: think });
      return { choices, meta };
    } finally {
      if (meta.usage) {
        calibrateTokens(calibration, meta.promptChars, meta.usage.promptTokens);
        usage.prompt += meta.usage.promptTokens ?? 0;
        usage.output += meta.usage.outputTokens ?? 0;
        usage.thoughts += meta.usage.thoughtTokens ?? 0;
      }
    }
  };

  const rankWithBisection = async (group) => {
    if (blocked || !group.length) return;
    let result;
    try {
      result = await rankGroup(group);
    } catch (error) {
      if (isBlocked(error)) { blocked = error; return; }
      if (error instanceof MatchContentError) {
        // Something in the request was refused: halve until the offending film is alone.
        if (group.length > 1) {
          const mid = Math.ceil(group.length / 2);
          await rankWithBisection(group.slice(0, mid));
          await rankWithBisection(group.slice(mid));
          return;
        }
        await finish(group[0].row, group[0].candidates, failure('model-refused'), null);
        return;
      }
      for (const item of group) await finish(item.row, item.candidates, failure('rank-failed'), null);
      consecutiveFailures += 1;
      warn('[worker] tmdb ai match batch failed: ' + String(error.message).slice(0, 200));
      return;
    }
    consecutiveFailures = 0;
    const { choices, meta } = result;
    if (meta.model) models.set(meta.model + '@' + meta.key, (models.get(meta.model + '@' + meta.key) ?? 0) + 1);
    for (const [index, item] of group.entries()) {
      await finish(item.row, item.candidates, decideAiMatch({ input: item.input, candidates: item.candidates, choice: choices.get('m' + index) }), meta.model ?? null);
    }
  };

  const maxPacks = options.maxPacks ?? Infinity;
  let packs = 0;
  while (!blocked && packs < maxPacks && !isStopping() && consecutiveFailures < MAX_CONSECUTIVE_BATCH_FAILURES) {
    const pack = await nextPack();
    if (!pack.length) break;
    packs += 1;
    await rankWithBisection(pack);
  }

  out.blocked = blocked;
  out.changed = [...new Set(changed)];
  const used = [...models].map(([name, n]) => name + 'x' + n).join(',') || 'none';
  if (counts.checked || out.requests) {
    log('[worker] tmdb ai match mode=' + mode + ' scope=' + (options.scope ?? 'all') + ' requests=' + out.requests + ' checked=' + counts.checked +
      ' verified=' + counts.verified + ' unverifiable=' + counts.unverifiable + ' none=' + counts.none + ' error=' + counts.error +
      ' merged=' + counts.merged + ' assigned=' + counts.assigned + ' tokens=' + usage.prompt + '/' + usage.output + '/' + usage.thoughts +
      ' models=' + used);
  }
  return out;
}

/** Legacy whole pass for the sync cycle (TMDB_MATCH_AI_LOOP=false). Returns changed canonical slugs. */
export async function refreshTmdbAiMatches(deps = {}) {
  const settings = deps.config ?? config;
  if (!aiPassAvailable(settings)) return [];
  const now = deps.now ?? (() => Date.now());
  const state = deps.state ?? shared;
  if (now() < (state.blockedUntil ?? 0)) return [];
  const result = await runAiMatchPass(deps, { scope: 'all' });
  if (result.blocked) {
    state.blockedUntil = now() + (result.blocked.retryAfterMs ?? 60000);
    (deps.log ?? ((message) => console.log(message)))('[worker] tmdb ai match: AI quota exhausted, resuming next cycle');
  }
  return result.changed;
}
