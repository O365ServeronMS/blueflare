const DAY_MS = 24 * 60 * 60 * 1000;
// A source is only retired after two 404s at least this far apart.
export const NOT_FOUND_MIN_GAP_MS = 7 * DAY_MS;

const HOUR_MS = 60 * 60 * 1000;
// Delays applied when a refresh attempt does not end in a successful upsert.
export const NOT_FOUND_RECHECK_MS = NOT_FOUND_MIN_GAP_MS + HOUR_MS;
export const DRY_RUN_CONFIRMED_RECHECK_MS = 3 * DAY_MS;
export const TRANSIENT_RECHECK_MS = DAY_MS;
// A unique violation is deterministic, so retrying every cycle cannot succeed.
export const CONFLICT_RECHECK_MS = DAY_MS;

export function isNotFound(error) {
  return Number(error?.status) === 404;
}

async function defer(deps, row, delayMs, log) {
  try { await deps.defer(row.id, delayMs); }
  catch (error) { log.warn('[worker] stale source defer failed for ' + row.provider_slug, error.message); }
}

/**
 * Re-fetch detail for sources the sync no longer touches and force an upsert.
 *
 * Only a 404 counts toward unavailability; every other failure is transient and
 * is logged and forgotten. Availability changes only in mode 'apply', after two
 * 404s NOT_FOUND_MIN_GAP_MS apart. Returns counters plus the canonical slugs
 * whose rows changed, for the cycle's invalidation. Every attempt that does not
 * end in a successful upsert defers the source through deps.defer, so a failing
 * source cannot hold the head of the queue. In 'apply', a movie left with no
 * available source is hard-deleted (deps.deleteIfNoSource).
 */
export async function refreshStaleSources({ mode, providers, deps, settings, isStopping = () => false, log = console }) {
  const stats = {
    mode, checked: 0, refreshed: 0, unchanged: 0, notFound: 0, transient: 0, conflicts: 0, deferred: 0,
    wouldMark: 0, marked: 0, deleted: 0, unseen: 0, noSourceMovies: 0, changedSlugs: [], durationMs: 0
  };
  if (mode === 'off' || !providers.length) return stats;
  const startedAt = Date.now();
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const rows = await deps.listStale([...byName.keys()], settings.staleMs, settings.batch);
  const flagged = [];

  await deps.mapLimit(rows, settings.concurrency, async (row) => {
    if (isStopping()) return;
    const provider = byName.get(row.provider);
    const key = row.provider + '/' + row.provider_slug;
    stats.checked += 1;
    try {
      const { normalized } = await provider.detail(row.provider_slug);
      const result = await deps.upsert(normalized);
      stats.refreshed += 1;
      if (result.changed) stats.changedSlugs.push(result.movie.canonical_slug);
      else stats.unchanged += 1;
    } catch (error) {
      if (error?.code === '23505') {
        stats.conflicts += 1;
        log.warn('[worker] stale source ' + key + ' unique conflict, backing off', error.message);
        await defer(deps, row, CONFLICT_RECHECK_MS, log);
        return;
      }
      if (!isNotFound(error)) {
        stats.transient += 1;
        log.warn('[worker] stale source ' + row.provider + '/' + row.provider_slug + ' refresh failed', error.message);
        await defer(deps, row, TRANSIENT_RECHECK_MS, log);
        return;
      }
      stats.notFound += 1;
      const state = await deps.recordNotFound(row.id, NOT_FOUND_MIN_GAP_MS).catch((recordError) => {
        log.warn('[worker] stale source 404 record failed for ' + row.provider_slug, recordError.message);
        return null;
      });
      if (!state) await defer(deps, row, TRANSIENT_RECHECK_MS, log);
      else if (!state.confirmed) await defer(deps, row, NOT_FOUND_RECHECK_MS, log);
      else {
        flagged.push(row);
        if (mode === 'dry-run') await defer(deps, row, DRY_RUN_CONFIRMED_RECHECK_MS, log);
      }
    }
  });

  stats.wouldMark = flagged.length;
  const movieIds = [...new Set(flagged.map((row) => row.movie_id))];
  const flaggedIds = flagged.map((row) => row.id);
  // Counted before apply deletes anything, so the line reads the same in both modes.
  stats.noSourceMovies = await deps.countNoSource(movieIds, flaggedIds).catch((error) => {
    log.warn('[worker] stale source no-source count failed', error.message);
    return 0;
  });
  if (mode === 'apply') {
    const unmarked = new Set(flagged);
    const markedMovies = new Set();
    for (const row of flagged) {
      if (isStopping()) break;
      const slug = await deps.markUnavailable(row.id).catch((markError) => {
        log.warn('[worker] stale source mark failed for ' + row.provider_slug, markError.message);
        return null;
      });
      if (slug) {
        unmarked.delete(row);
        markedMovies.add(row.movie_id);
        stats.marked += 1;
        stats.changedSlugs.push(slug);
      }
    }
    // Not marked (failed, already unavailable or interrupted): do not return to the head.
    for (const row of unmarked) await defer(deps, row, TRANSIENT_RECHECK_MS, log);
    // A movie whose last available source was just retired is deleted outright.
    for (const movieId of markedMovies) {
      if (isStopping()) break;
      const slug = await deps.deleteIfNoSource(movieId).catch((deleteError) => {
        log.warn('[worker] stale source movie delete failed for ' + movieId, deleteError.message);
        return null;
      });
      if (slug) {
        stats.deleted += 1;
        log.warn('[worker] stale source deleted movie ' + slug + ' (no available source left)');
      }
    }
  }
  try {
    stats.unseen = await deps.countUnseen([...byName.keys()], settings.staleMs);
    stats.deferred = await deps.countDeferred([...byName.keys()], settings.staleMs);
  } catch (error) {
    log.warn('[worker] stale source stats failed', error.message);
  }
  for (const row of flagged) {
    if (mode === 'dry-run') log.log('[worker] stale source dry-run would mark unavailable ' + row.provider + '/' + row.provider_slug);
  }
  stats.durationMs = Date.now() - startedAt;
  return stats;
}

export function formatStaleStats(stats) {
  return 'mode=' + stats.mode + ' checked=' + stats.checked + ' refreshed=' + stats.refreshed +
    ' unchanged=' + stats.unchanged + ' notFound=' + stats.notFound + ' transient=' + stats.transient +
    ' conflicts=' + stats.conflicts + ' deferred=' + stats.deferred +
    ' wouldMark=' + stats.wouldMark + ' marked=' + stats.marked + ' deleted=' + stats.deleted +
    ' noSourceMovies=' + stats.noSourceMovies + ' unseenSinceSweep=' + stats.unseen +
    ' durationMs=' + stats.durationMs;
}
