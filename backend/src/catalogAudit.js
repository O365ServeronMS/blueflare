/**
 * Weekly catalog audit, the fifth worker loop. One run:
 *   1. load every ready row and flag suspicious groups (catalogAuditExtract.js),
 *   2. fetch TMDB /tv facts for the tv ids in groups the model looks at,
 *   3. propose: deterministic rules (orphans, aliases/slugs naming another season) and the model
 *      (AI role DEDUPE) for the groups that need judgement,
 *   4. gate every proposed action (catalogAuditGate.js) and, in apply mode, write it
 *      (catalogAuditApply.js) under the catalog lock so it never overlaps a sync cycle.
 * Every proposal lands in catalog_audit_actions (dry-run/applied/blocked/failed) for the report
 * and undo scripts. Never on a request path. The model never writes: it only names actions on ids
 * of its group, and the gate decides.
 */
import { config } from './config.js';
import { pool } from './db.js';
import { getAi, AiError } from './ai/index.js';
import { createTmdbClient } from './tmdbMatchAi.js';
import { analyseCatalog, groupForModel, loadCatalog, loadRows, needsModel, tvFacts } from './catalogAuditExtract.js';
import { ACTIONS, createState, deterministicActions, gateProposal } from './catalogAuditGate.js';
import { applyAuditAction } from './catalogAuditApply.js';
import { retryDelayMs, waitFor } from './workerLoop.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const VIETNAM_OFFSET_MS = 7 * HOUR_MS;
const MAX_FAILED_TRIES = 3;

// ---- schedule ------------------------------------------------------------------------------

/** Start of the most recent weekly slot (day 0 = Sunday, hour in Vietnam time) at or before `now`. */
export function lastSlot(now, day = 0, hour = 3) {
  const local = new Date(now + VIETNAM_OFFSET_MS);
  const slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour) - VIETNAM_OFFSET_MS;
  let at = slot - ((local.getUTCDay() - day + 7) % 7) * DAY_MS;
  if (at > now) at -= 7 * DAY_MS;
  return at;
}

export const nextSlot = (now, day, hour) => lastSlot(now, day, hour) + 7 * DAY_MS;

/**
 * True when the current slot has no finished run in the current mode and fewer than MAX_FAILED_TRIES failed ones.
 * Only a run of the same mode finishes the slot, so switching dry-run to apply redoes it at once.
 */
export async function runDue(now = Date.now(), { db = pool, settings = config } = {}) {
  const slot = new Date(lastSlot(now, settings.catalogAuditDay, settings.catalogAuditHour));
  const result = await db.query(
    // a 'partial' stopped by shutdown (written before such runs became 'failed') counts as a failed try
    "SELECT count(*) FILTER (WHERE (status='done' OR (status='partial' AND summary->>'stopped' IS DISTINCT FROM 'stopping')) AND summary->>'mode'=$2)::int AS finished, " +
    "count(*) FILTER (WHERE status='failed' OR (status='partial' AND summary->>'stopped'='stopping'))::int AS failed " +
    'FROM catalog_audit_runs WHERE started_at >= $1', [slot, settings.catalogAuditMode]);
  const { finished, failed } = result.rows[0];
  return finished === 0 && failed < MAX_FAILED_TRIES;
}

// ---- catalog lock --------------------------------------------------------------------------

/** In-process mutex: the sync cycle and the audit's writes take turns. */
export function createLock() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.catch(() => {});
      return result;
    }
  };
}

export const catalogLock = createLock();

// ---- model ---------------------------------------------------------------------------------

export const AUDIT_SYSTEM_PROMPT = [
  'You clean the catalog of a Vietnamese streaming site so every row maps to exactly one TheMovieDB (TMDB) page: one movie, or one season of a series.',
  'You get groups of suspicious catalog rows. Each row lists its provider records ("sources") from two providers: kkphim (often carries a TMDB id and season) and nguonc.',
  'Field notes: "season" is the season the row stands for; each source has the season it describes and "signals" (how many of its TMDB season, title, original title and slug agree). "flags" name what looked wrong. "tmdb" at group level lists real TMDB seasons (n, first-air year, episodes).',
  'Propose the fixes for each group with these actions only:',
  '- set_season {movieId, season}: the row\'s TMDB season is wrong; its own titles/slug and most sources name another season.',
  '- move_source {sourceId}: the source describes another season or another work than its row; it will be re-attached to the right row automatically.',
  '- merge_rows {keepId, dropId}: two rows are the same movie or the same season (one has a TMDB id, the other not).',
  '- fix_alias {slug, toMovieId}: an alias slug naming season N belongs to the group\'s row of season N.',
  '- rename_slug {movieId}: the row\'s canonical slug names another season than the row.',
  '- clear_tmdb {movieId}: the row\'s TMDB id is wrong (kkphim sources name another one).',
  '- report {movieId, note}: something is wrong that none of the actions fixes (e.g. a series stored as a movie); a human will look.',
  '- none {}: the group is fine.',
  'Rules: use only ids that appear in the group. Order matters: fix seasons before moving sources. Prefer the evidence of several agreeing signals; never move a source that agrees with its row. When unsure, answer none. Every action has a short English "reason".',
  'Answer only a JSON object {"groups":[{"key":"<group key>","actions":[{"type":"...", ...params, "reason":"..."}]}]} with one entry per group. No markdown.'
].join('\n');

const actionKey = (a) => JSON.stringify(a, ['type', 'movieId', 'slug', 'sourceId']);
const refusal = (message) => Object.assign(new Error(message), { permanent: true });
const clip = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Validate the model's answer against the groups it was sent: unknown keys, action types and ids
 * outside the group are dropped (never the whole answer); a missing groups list is a refusal.
 */
export function parseAuditAnswer(data, groups) {
  const list = Array.isArray(data?.groups) ? data.groups : Array.isArray(data) ? data : null;
  if (!list) throw refusal('model returned no groups list');
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const out = new Map();
  for (const entry of list) {
    const group = byKey.get(entry?.key);
    if (!group || out.has(group.key)) continue;
    const rowIds = new Set(group.rows.map((r) => r.id));
    const sourceIds = new Set(group.rows.flatMap((r) => r.sources.map((s) => Number(s.id))));
    const aliases = new Set(group.rows.flatMap((r) => r.aliases));
    const actions = [];
    for (const raw of Array.isArray(entry.actions) ? entry.actions : []) {
      const type = String(raw?.type || '');
      if (!ACTIONS.includes(type) || type === 'none') continue;
      const action = { type, reason: clip(raw.reason, 200) || null };
      const idOk = (name) => rowIds.has(raw[name]) && (action[name] = raw[name], true);
      let ok = true;
      if (['set_season', 'rename_slug', 'clear_tmdb', 'report', 'hide_row'].includes(type)) ok = idOk('movieId');
      if (type === 'set_season') { action.season = Number(raw.season); ok = ok && Number.isInteger(action.season); }
      if (type === 'report') action.note = clip(raw.note, 300) || null;
      if (type === 'merge_rows') ok = idOk('keepId') && idOk('dropId');
      if (type === 'move_source') { action.sourceId = Number(raw.sourceId); ok = sourceIds.has(action.sourceId); }
      if (type === 'fix_alias') { action.slug = String(raw.slug || ''); ok = aliases.has(action.slug) && idOk('toMovieId'); }
      if (ok) actions.push(action);
    }
    out.set(group.key, actions);
  }
  return out;
}

/** One DEDUPE request for a batch of model-shaped groups. Returns Map key -> actions and the model name. */
export async function proposeBatch(ai, groups, { signal, estTokens } = {}) {
  const messages = [
    { role: 'system', content: AUDIT_SYSTEM_PROMPT },
    { role: 'user', content: 'Catalog groups (JSON):\n' + JSON.stringify(groups) }
  ];
  const result = await ai.json('DEDUPE', messages, {
    temperature: 0, maxTokens: Math.min(32768, 2000 + 600 * groups.length), estTokens, signal,
    accept: (data) => parseAuditAnswer(data, groups)
  });
  return { proposals: result.value, model: result.model };
}

/** Split model-shaped groups into requests under the token budget and group count. */
export function packGroups(groups, { maxGroups = 8, maxTokens = 16000, charsPerToken = 3 } = {}) {
  const packs = [];
  let current = [];
  let tokens = 0;
  for (const group of groups) {
    const size = Math.ceil(JSON.stringify(group).length / charsPerToken);
    if (current.length && (current.length >= maxGroups || tokens + size > maxTokens)) { packs.push(current); current = []; tokens = 0; }
    current.push(group);
    tokens += size;
  }
  if (current.length) packs.push(current);
  return packs;
}

// ---- one run -------------------------------------------------------------------------------

async function startRun(db, mode) {
  await db.query("UPDATE catalog_audit_runs SET status='failed', finished_at=now(), error='interrupted' WHERE status='running'");
  return (await db.query('INSERT INTO catalog_audit_runs (mode) VALUES ($1) RETURNING id', [mode])).rows[0].id;
}

async function recordAction(db, runId, group, verdict, extra = {}) {
  const { action } = verdict;
  const { type, reason, ...params } = action;
  await db.query(
    'INSERT INTO catalog_audit_actions (run_id, group_key, detectors, action, params, reason, status, gate, before, after, slugs, identity_change_id, model) ' +
    'VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)',
    [runId, group.key, group.detectors, type, JSON.stringify(params), reason ?? null, extra.status, extra.gate ?? null,
      JSON.stringify(extra.before ?? null), JSON.stringify(extra.after ?? verdict.detail ?? null), extra.slugs ?? verdict.slugs ?? group.rows.map((r) => r.canonical_slug),
      extra.identityChangeId ?? null, extra.model ?? null]
  );
}

async function fetchFacts(groups, client, isStopping) {
  const ids = new Set();
  for (const group of groups) for (const row of group.rows) if (row.tmdb_media_type === 'tv' && row.tmdb_id !== null) ids.add(Number(row.tmdb_id));
  const facts = new Map();
  for (const id of ids) {
    if (isStopping()) break;
    try {
      const fact = tvFacts(await client.get('/tv/' + id, { language: '' }));
      if (fact) facts.set(id, fact);
    } catch { /* a group without facts simply fails set_season's gate */ }
  }
  return facts;
}

/**
 * One audit run. deps: { db, ai, tmdb, providers (Map name -> provider), upsert, onChanged(slugs),
 * isStopping, log, lock }. Returns the summary stored on the run row.
 */
export async function runCatalogAudit(deps = {}) {
  const settings = deps.config ?? config;
  const db = deps.db ?? pool;
  const mode = settings.catalogAuditMode;
  const isStopping = deps.isStopping ?? (() => false);
  const log = deps.log ?? ((message) => console.log(message));
  const lock = deps.lock ?? catalogLock;
  const runId = await startRun(db, mode);
  const summary = { mode, counts: null, groups: 0, modelGroups: 0, requests: 0, statuses: {}, actions: {}, gates: {}, model: null, stopped: null };
  const tally = (verdict, status, gate) => {
    summary.statuses[status] = (summary.statuses[status] || 0) + 1;
    summary.actions[verdict.action.type] = (summary.actions[verdict.action.type] || 0) + 1;
    if (gate) summary.gates[gate] = (summary.gates[gate] || 0) + 1;
  };
  const changed = new Set();
  let applied = 0;
  try {
    const startedAt = Date.now();
    const catalog = await loadCatalog(db, { isStopping });
    const { groups, counts, family, holderOf } = analyseCatalog(catalog);
    summary.counts = counts;
    summary.groups = groups.length;
    log('[worker] catalog audit run=' + runId + ' mode=' + mode + ' rows=' + catalog.length + ' groups=' + groups.length +
      ' loadMs=' + (Date.now() - startedAt));

    // Proposals: deterministic first, then the model for the groups that need judgement.
    const proposals = new Map(groups.map((g) => [g.key, { actions: deterministicActions(g, family), model: null }]));
    const modelGroups = groups.filter(needsModel);
    summary.modelGroups = modelGroups.length;
    const ai = deps.ai ?? getAi();
    let facts = new Map();
    if (modelGroups.length && ai.available('DEDUPE')) {
      await ai.ready();
      const tmdb = deps.tmdb ?? (settings.tmdbEnabled && settings.tmdbApiKey ? createTmdbClient({ concurrency: 2 }) : null);
      if (tmdb) facts = await fetchFacts(modelGroups, tmdb, isStopping);
      const shaped = modelGroups.map((g) => groupForModel(g, facts));
      for (const pack of packGroups(shaped, { maxGroups: settings.catalogAuditBatch, maxTokens: settings.catalogAuditBatchTokens })) {
        if (isStopping()) { summary.stopped = 'stopping'; break; }
        try {
          const { proposals: answer, model } = await proposeBatch(ai, pack, { signal: deps.signal });
          summary.requests += 1;
          summary.model = model;
          for (const [key, actions] of answer) {
            const entry = proposals.get(key);
            // Deterministic fixes first (a refused model action then cannot hold them back), the model's after, minus duplicates.
            const seen = new Set(entry.actions.map(actionKey));
            entry.actions = [...entry.actions, ...actions.filter((a) => !seen.has(actionKey(a)))];
            entry.model = model;
          }
        } catch (error) {
          if (error instanceof AiError && error.kind === 'content') continue;
          if (error instanceof AiError && error.kind === 'unavailable') { summary.stopped = 'ai-unavailable'; break; }
          throw error;
        }
      }
    } else if (modelGroups.length) {
      summary.stopped = 'ai-off';
    }

    // Gate and record (apply mode writes under the lock; each group is re-read first).
    for (const group of groups) {
      if (isStopping()) { summary.stopped = 'stopping'; break; }
      const proposal = proposals.get(group.key);
      if (!proposal.actions.length) continue;
      if (mode !== 'apply') {
        const state = createState(group.rows, { facts, holderOf, family });
        for (const verdict of gateProposal(state, proposal.actions)) {
          const status = verdict.ok ? 'dry-run' : 'blocked';
          tally(verdict, status, verdict.gate);
          await recordAction(db, runId, group, verdict, { status, gate: verdict.gate, model: proposal.model });
        }
        continue;
      }
      await lock.run(async () => {
        const fresh = (await loadRows(db, group.rows.map((r) => r.id))).filter((r) => r.catalog_state === 'ready');
        const state = createState(fresh, { facts, holderOf, family });
        let broken = false;
        for (const verdict of gateProposal(state, proposal.actions)) {
          let outcome;
          if (!verdict.ok) outcome = { status: 'blocked', gate: verdict.gate };
          else if (broken) outcome = { status: 'blocked', gate: 'earlier-action-failed' };
          else if (applied >= settings.catalogAuditMaxActions) outcome = { status: 'dry-run', gate: 'over-cap' };
          else {
            outcome = await applyAuditAction(verdict, { ...deps, runId });
            if (outcome.status === 'applied') { applied += 1; for (const slug of outcome.slugs || []) changed.add(slug); }
            // the state the next action was gated on did not happen
            if (outcome.status !== 'applied') broken = true;
          }
          tally(verdict, outcome.status, outcome.gate);
          await recordAction(db, runId, group, verdict, { ...outcome, model: proposal.model });
        }
      });
      if (changed.size >= 50 && deps.onChanged) { await flush(deps, changed, log); }
    }
    if (deps.onChanged) await flush(deps, changed, log);
    // A shutdown is not a finished run: 'failed' lets runDue redo the slot after the restart (deploys stop the worker).
    const status = summary.stopped === 'stopping' ? 'failed' : summary.stopped ? 'partial' : 'done';
    await db.query('UPDATE catalog_audit_runs SET status=$2, finished_at=now(), groups=$3, summary=$4::jsonb, error=$5 WHERE id=$1',
      [runId, status, summary.groups, JSON.stringify(summary), status === 'failed' ? 'interrupted' : null]);
    log('[worker] catalog audit run=' + runId + ' ' + status + ' statuses=' + JSON.stringify(summary.statuses) +
      ' requests=' + summary.requests + (summary.stopped ? ' stopped=' + summary.stopped : ''));
    return { runId, status, summary };
  } catch (error) {
    await db.query("UPDATE catalog_audit_runs SET status='failed', finished_at=now(), summary=$2::jsonb, error=$3 WHERE id=$1",
      [runId, JSON.stringify(summary), String(error.message).slice(0, 500)]).catch(() => {});
    throw error;
  }
}

async function flush(deps, changed, log) {
  if (!changed.size) return;
  const slugs = [...changed];
  changed.clear();
  await Promise.resolve(deps.onChanged(slugs)).catch((error) => log('[worker] catalog audit invalidation failed: ' + error.message));
}

// ---- loop ----------------------------------------------------------------------------------

/**
 * Runs until `signal` aborts: at start (catch-up) and at each weekly slot, one run when due.
 * Sleeps at most an hour at a time so a changed clock or a long outage is noticed.
 */
export async function runCatalogAuditLoop(options = {}) {
  const { signal, sleep = waitFor } = options;
  const settings = options.config ?? config;
  const warn = options.warn ?? ((message) => console.warn(message));
  const now = options.now ?? (() => Date.now());
  let failures = 0;
  while (!signal?.aborted) {
    let delay = HOUR_MS;
    try {
      if (settings.catalogAuditMode !== 'off' && await runDue(now(), { db: options.db, settings })) {
        await runCatalogAudit({ ...options, isStopping: () => Boolean(signal?.aborted) });
      }
      failures = 0;
      delay = Math.min(HOUR_MS, Math.max(60000, nextSlot(now(), settings.catalogAuditDay, settings.catalogAuditHour) - now()));
    } catch (error) {
      failures += 1;
      delay = retryDelayMs(failures, 5 * 60000, HOUR_MS);
      warn('[worker] catalog audit failed: ' + String(error.message).slice(0, 200));
    }
    await sleep(delay, signal);
  }
}
