/**
 * Rating merge shared by the provider upsert, the duplicate merge and the TMDB
 * identity merge.
 *
 * Providers send 0/null for a score they do not have yet; that never erases a
 * stored value. `tmdb`/`tmdb_count` fetched straight from TMDB (marked by
 * `tmdb_src` = '<type>:<id>') beat the provider snapshot, but only while the
 * row still holds that identity: after a clear/assign/merge the mark is stale
 * and a provider score is taken again.
 */
const TMDB_KEYS = ['tmdb', 'tmdb_count'];

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

export function tmdbSrc(type, id) {
  return type && id ? String(type) + ':' + String(id) : null;
}

function selfFetched(ratings, src) {
  return Boolean(src) && ratings?.tmdb_src === src && positive(ratings.tmdb);
}

/** True when `ratings` carries a self-fetched TMDB score that does not belong to type:id. */
export function hasStaleTmdbScore(ratings, type, id) {
  return Boolean(ratings?.tmdb_src) && ratings.tmdb_src !== tmdbSrc(type, id);
}

export function mergeRatings(current, incoming, { tmdbType = null, tmdbId = null } = {}) {
  const base = current || {};
  const next = incoming || {};
  const src = tmdbSrc(tmdbType, tmdbId);
  const result = { ...base };
  // A self-fetched score belongs to the identity it was fetched for; once the row holds another
  // (or none) it is wrong and a provider null/0 could never erase it. Provider snapshots carry
  // no tmdb_src and are kept.
  if (base.tmdb_src && base.tmdb_src !== src) {
    delete result.tmdb;
    delete result.tmdb_count;
    delete result.tmdb_src;
  }
  const keepCurrentTmdb = selfFetched(result, src) && !selfFetched(next, src);
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === 0) continue;
    if (key === 'tmdb_src') {
      if (!keepCurrentTmdb) result.tmdb_src = value;
      continue;
    }
    if (TMDB_KEYS.includes(key) && keepCurrentTmdb) continue;
    result[key] = value;
    // A provider score replacing a stale self-fetched one drops its mark.
    if (key === 'tmdb' && !('tmdb_src' in next)) delete result.tmdb_src;
  }
  return result;
}
