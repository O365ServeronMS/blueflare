const DAY_MS = 24 * 60 * 60 * 1000;
// A source is only retired after two 404s at least this far apart.
export const NOT_FOUND_MIN_GAP_MS = 7 * DAY_MS;

// A unique violation is deterministic: retrying every cycle cannot succeed, so the source
// is skipped for a while. In memory only; a worker restart simply retries once.
export const CONFLICT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const conflictUntil = new Map();

export function resetConflictBackoff() {
  conflictUntil.clear();
}

export function isNotFound(error) {
  return Number(error?.status) === 404;
}

/**
 * Re-fetch detail for sources the sync no longer touches and force an upsert.
 *
 * Only a 404 counts toward unavailability; every other failure is transient and
 * is logged and forgotten. Availability changes only in mode 'apply', after two
 * 404s NOT_FOUND_MIN_GAP_MS apart. Returns counters plus the canonical slugs
 * whose rows changed, for the cycle's invalidation.
 */
export async function refreshStaleSources({ mode, providers, deps, settings, isStopping = () => false, log = console }) {
  const stats = {
    mode, checked: 0, refreshed: 0, unchanged: 0, notFound: 0, transient: 0, conflicts: 0, skipped: 0,
    wouldMark: 0, marked: 0, unseen: 0, noSourceMovies: 0, changedSlugs: [], durationMs: 0
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
    if ((conflictUntil.get(key) || 0) > Date.now()) {
      stats.skipped += 1;
      return;
    }
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
        conflictUntil.set(key, Date.now() + CONFLICT_COOLDOWN_MS);
        log.warn('[worker] stale source ' + key + ' unique conflict, backing off', error.message);
        return;
      }
      if (!isNotFound(error)) {
        stats.transient += 1;
        log.warn('[worker] stale source ' + row.provider + '/' + row.provider_slug + ' refresh failed', error.message);
        return;
      }
      stats.notFound += 1;
      const state = await deps.recordNotFound(row.id, NOT_FOUND_MIN_GAP_MS).catch((recordError) => {
        log.warn('[worker] stale source 404 record failed for ' + row.provider_slug, recordError.message);
        return null;
      });
      if (state?.confirmed) flagged.push(row);
    }
  });

  stats.wouldMark = flagged.length;
  if (mode === 'apply') {
    for (const row of flagged) {
      if (isStopping()) break;
      const slug = await deps.markUnavailable(row.id).catch((markError) => {
        log.warn('[worker] stale source mark failed for ' + row.provider_slug, markError.message);
        return null;
      });
      if (slug) {
        stats.marked += 1;
        stats.changedSlugs.push(slug);
      }
    }
  }
  const movieIds = [...new Set(flagged.map((row) => row.movie_id))];
  const flaggedIds = flagged.map((row) => row.id);
  try {
    stats.noSourceMovies = await deps.countNoSource(movieIds, flaggedIds);
    stats.unseen = await deps.countUnseen([...byName.keys()], settings.staleMs);
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
    ' conflicts=' + stats.conflicts + ' skipped=' + stats.skipped +
    ' wouldMark=' + stats.wouldMark + ' marked=' + stats.marked +
    ' noSourceMovies=' + stats.noSourceMovies + ' unseenSinceSweep=' + stats.unseen +
    ' durationMs=' + stats.durationMs;
}
