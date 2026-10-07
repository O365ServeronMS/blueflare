import { config } from './config.js';
import { aiPassAvailable, runAiMatchPass, sharedAiRotation } from './tmdbMatchAiSync.js';
import { retryDelayMs, waitFor } from './workerLoop.js';

/**
 * Fourth background loop (next to provider sync, image prewarm and the cache sweep):
 * spends the Gemini free-tier quota on the TMDB AI match backlog without holding up the
 * sync cycle. It wakes every TMDB_MATCH_AI_LOOP_MS, asks the quota ledger what is left of
 * today's requests (Pacific day), and ranks one token-packed batch per tick until the day's
 * quota or the backlog is gone. About TMDB_MATCH_AI_RESERVE_PCT of the day is kept for new
 * films and retries ('priority' scope); the old backlog may only use what lies above that.
 * Never on a request path. Promotion of verified matches stays in the sync cycle.
 */

const MAX_FREE_SWEEPS = 50;
const MAX_DELAY_MS = 15 * 60 * 1000;
const IDLE_FACTOR = 5;

export const aiLoopEnabled = (settings = config) => settings.tmdbMatchAiLoop !== false;

/**
 * One wake-up. Returns `{ status: 'off'|'quota'|'blocked'|'worked'|'idle', changed, requests, retryAfterMs? }`.
 * Passes that only finished films needing no model (no candidates, TMDB errors) cost no
 * quota, so they repeat within the tick until a request is made or the listing is empty.
 */
export async function tmdbMatchAiTick(deps = {}) {
  const settings = deps.config ?? config;
  const result = { status: 'off', changed: [], requests: 0 };
  if (!aiPassAvailable(settings)) return result;
  const rotation = deps.rotation ?? sharedAiRotation(settings, deps);
  await rotation.ready?.();
  const quota = rotation.quota?.() ?? { total: null, remaining: null };
  if (quota.remaining != null && quota.remaining <= 0) {
    return { ...result, status: 'quota', retryAfterMs: Math.max(0, (quota.resetAt ?? 0) - (deps.now ?? Date.now)()) };
  }
  const reserve = quota.total ? Math.ceil((quota.total * (settings.tmdbMatchAiReservePct ?? 10)) / 100) : 0;
  const rowLimit = Math.max(1, settings.tmdbMatchGeminiBatchMax ?? 40);

  const run = async (scope) => {
    let last;
    for (let sweep = 0; sweep < MAX_FREE_SWEEPS; sweep += 1) {
      last = await runAiMatchPass({ ...deps, rotation }, { scope, rowLimit, maxPacks: 1 });
      result.changed.push(...last.changed);
      result.requests += last.requests;
      if (last.blocked || last.skipped || last.requests > 0 || last.listed === 0 || deps.isStopping?.()) break;
    }
    return last;
  };

  let pass = await run('priority');
  if (!pass.blocked && !pass.skipped && pass.listed === 0 && (quota.remaining == null || quota.remaining > reserve)) pass = await run('all');
  if (pass.blocked) return { ...result, status: 'blocked', retryAfterMs: pass.blocked.retryAfterMs ?? null };
  if (pass.skipped) return { ...result, status: 'off' };
  return { ...result, status: pass.listed === 0 ? 'idle' : 'worked' };
}

/**
 * Runs until `signal` aborts. `onChanged(slugs)` receives the canonical slugs an apply-mode
 * pass changed so the worker can invalidate caches. Errors never escape: the loop backs off.
 */
export async function runTmdbMatchAiLoop(options = {}) {
  const { signal, onChanged, sleep = waitFor } = options;
  const settings = options.config ?? config;
  const log = options.log ?? ((message) => console.log(message));
  const warn = options.warn ?? ((message) => console.warn(message));
  const baseMs = settings.tmdbMatchAiLoopMs ?? 60000;
  let failures = 0;
  let lastStatus = null;
  while (!signal?.aborted) {
    let delay = baseMs;
    try {
      const tick = await tmdbMatchAiTick({ ...options, signal, isStopping: () => Boolean(signal?.aborted) });
      failures = 0;
      if (tick.changed.length && onChanged) {
        await Promise.resolve(onChanged(tick.changed)).catch((error) => warn('[worker] tmdb ai match invalidation failed: ' + error.message));
      }
      if (tick.status === 'idle') delay = baseMs * IDLE_FACTOR;
      if (tick.status === 'blocked') delay = Math.min(MAX_DELAY_MS, Math.max(baseMs, tick.retryAfterMs ?? 0));
      if (tick.status === 'quota') delay = Math.min(MAX_DELAY_MS, Math.max(baseMs, Math.min(tick.retryAfterMs ?? 0, MAX_DELAY_MS)));
      if (tick.status !== lastStatus && ['quota', 'blocked', 'idle'].includes(tick.status)) {
        log('[worker] tmdb ai match loop: ' + tick.status + (tick.status === 'idle' ? ' (backlog empty)' : tick.status === 'quota' ? ' (daily requests spent until the Pacific reset)' : ''));
      }
      lastStatus = tick.status;
    } catch (error) {
      failures += 1;
      delay = retryDelayMs(failures, baseMs, MAX_DELAY_MS);
      warn('[worker] tmdb ai match loop tick failed: ' + String(error.message).slice(0, 200));
    }
    await sleep(delay, signal);
  }
}
