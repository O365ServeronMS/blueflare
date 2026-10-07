import { createHash } from 'node:crypto';
import { collectAiCandidates, createTmdbClient, matchInput, promptEntry, rankBatch } from '../../src/tmdbMatchAi.js';
import { jsonlCache, tmdbOptions, pool, OUT } from './aiTools.mjs';

/** TMDB client that replays from OUT/tmdb-cache.jsonl; only 'search' and detail bodies are cached. */
export async function openTmdbClient() {
  const cache = await jsonlCache(OUT + '/tmdb-cache.jsonl');
  const client = createTmdbClient({ tmdb: tmdbOptions(), cache });
  return { client, cache };
}

/** rows -> Map(rowId -> { queries, candidates } | { error }). Rows are sanitised before anything touches them. */
export async function collectAll(rows, client, { workers = 4, onProgress } = {}) {
  const out = new Map();
  let done = 0;
  await pool(rows, workers, async (row) => {
    const input = matchInput(row);
    try { out.set(row.id, await collectAiCandidates(input, client)); }
    catch (error) { out.set(row.id, { error: String(error.message || error), queries: [], candidates: [] }); }
    done += 1;
    if (onProgress && done % 50 === 0) onProgress(done, rows.length);
  });
  return out;
}

export const entriesHash = (entries) => createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 24);

/**
 * Rank rows in batches. `evidence`: [{ row, candidates }]. Returns Map(rowId -> choice) plus request stats.
 * Gemini answers are cached by prompt content, so replays cost nothing.
 */
export async function rankAll(evidence, rotations, { batch = 10, parallel = 3, cache, onProgress, log = () => {} } = {}) {
  const withCands = evidence.filter((e) => e.candidates.length);
  const batches = [];
  for (let i = 0; i < withCands.length; i += batch) batches.push(withCands.slice(i, i + batch));
  const choices = new Map();
  const stats = { requests: 0, cached: 0, failed: 0, failures: {}, models: {}, latencyMs: [], blocked: null, gaveUp: 0 };
  let done = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await pool(batches, parallel, async (group) => {
    if (stats.blocked) return;
    const entries = group.map((e, i) => promptEntry('m' + (i + 1), matchInput(e.row), e.candidates));
    const key = 'rank|' + entriesHash(entries);
    let answer = await cache.get(key);
    if (answer) stats.cached += 1;
    // Best model first; a 503 / timeout / cooldown moves on to the next model, a full lap waits and starts again.
    for (let lap = 0; lap < 5 && !answer && !stats.blocked; lap += 1) {
      let allDaily = true;
      for (const { model, call } of rotations) {
        if (answer) break;
        const meta = {};
        const started = Date.now();
        try {
          stats.requests += 1;
          const map = await rankBatch(call, entries, undefined, meta);
          stats.latencyMs.push(Date.now() - started);
          stats.models[meta.model + '/' + meta.key] = (stats.models[meta.model + '/' + meta.key] || 0) + 1;
          answer = Object.fromEntries(map);
          cache.set(key, answer);
        } catch (error) {
          stats.failed += 1;
          const tag = model + ' ' + (error.blocked ? 'blocked' : error.status || error.name);
          stats.failures[tag] = (stats.failures[tag] || 0) + 1;
          if (!(error.blocked && (error.retryAfterMs ?? 0) > 20 * 60 * 1000)) allDaily = false;
          if (error.blocked && error.retryAfterMs && error.retryAfterMs <= 30000) await sleep(error.retryAfterMs);
        }
      }
      if (!answer && allDaily) { stats.blocked = 'every model blocked for > 20 min (daily quota?)'; break; }
      if (!answer) await sleep(15000);
    }
    if (!answer && !stats.blocked) stats.gaveUp += 1;
    group.forEach((e, i) => { const c = answer?.['m' + (i + 1)]; if (c) choices.set(e.row.id, c); });
    done += 1;
    if (onProgress) onProgress(done, batches.length);
  });
  return { choices, stats };
}
