import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { fetchOmdbByImdbId } from './omdb.js';
import { fetchTmdbExternalIds } from './tmdb.js';

/**
 * OMDb score sync.
 *
 * OMDb's free tier allows 1000 requests per UTC day against a catalog of ~49k
 * rows, so this cannot be a crawl — a full pass would take ten days and spend
 * most of it on titles nobody opened. It is demand-driven instead, in the same
 * shape as `prewarm.js`: read the viewmodels the API is already serving, take
 * the rows a visitor is about to see, and spend the day's allowance on those.
 *
 * The consequence is the same as prewarming's: the first day fills the visible
 * set and every cycle after it costs nothing, because the hot rows are already
 * scored and not yet due for a re-check.
 *
 * Which lists are worth the budget is an env decision (`OMDB_RATING_TYPES`)
 * with a measured default. A 60-title probe over the live catalog found a
 * Tomatometer for 25% of trending rows and 15% of phim-le rows, and for none of
 * the 20 rows sampled across phim-bo, hoat-hinh and tv-shows.
 */

function itemsOf(source) {
  // 'trending' is the home hero array; every other bucket is a list payload.
  // Read explicitly rather than deep-scanning: the home payload also carries
  // the phimBo/hoatHinh rows, which would silently defeat the type filter.
  if (source?.bucket === 'trending') {
    return Array.isArray(source?.payload?.heroMovies) ? source.payload.heroMovies : [];
  }
  const items = source?.payload?.data?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * Flatten the configured surfaces into one ordered, de-duplicated slug list.
 *
 * Order is load-bearing: it is the order the budget is spent in, so the hero
 * comes before page 1 of a list, which comes before page 2.
 */
export function collectRatingSlugs(sources) {
  const slugs = [];
  const seen = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const item of itemsOf(source)) {
      const slug = String(item?.slug || '').trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}

function tmdbMediaType(movie) {
  if (movie.tmdb_media_type === 'movie' || movie.tmdb_media_type === 'tv') return movie.tmdb_media_type;
  return movie.media_type === 'movie' ? 'movie' : 'tv';
}

const REPOSITORY_DEPS = [
  ['listCandidates', 'listOmdbRatingCandidates'],
  ['reserveBudget', 'reserveOmdbBudget'],
  ['releaseBudget', 'releaseOmdbBudget'],
  ['recordScores', 'recordOmdbScores'],
  ['recordMiss', 'recordOmdbMiss']
];

/**
 * Resolve the persistence half of the dependencies, importing `repository.js`
 * only if the caller did not supply them.
 *
 * The lazy import is the point: `repository.js` pulls in `pg`, and importing it
 * at module scope would make this file — and any test of it — unloadable on a
 * checkout without `backend/node_modules`. The orchestration logic below has no
 * business needing a database driver present to be exercised.
 */
async function resolveRepositoryDeps(options) {
  const resolved = {};
  const missing = REPOSITORY_DEPS.filter(([name]) => !options[name]);
  const repository = missing.length ? await import('./repository.js') : null;
  for (const [name, exported] of REPOSITORY_DEPS) {
    resolved[name] = options[name] || repository[exported];
  }
  return resolved;
}

export async function syncOmdbRatings(sources, options = {}) {
  const startedAt = Date.now();
  const deps = {
    ...(await resolveRepositoryDeps(options)),
    fetchOmdb: options.fetchOmdb || fetchOmdbByImdbId,
    resolveExternalId: options.resolveExternalId || fetchTmdbExternalIds,
    batchLimit: options.batchLimit ?? config.omdbBatchLimit,
    concurrency: options.concurrency ?? config.omdbConcurrency,
    enabled: options.enabled ?? (config.omdbEnabled && Boolean(config.omdbApiKey)),
    tmdbEnabled: options.tmdbEnabled ?? (config.tmdbEnabled && Boolean(config.tmdbApiKey))
  };

  const stats = {
    visible: 0,
    selected: 0,
    reserved: 0,
    spent: 0,
    matched: 0,
    unmatched: 0,
    tomato: 0,
    lifted: 0,
    noId: 0,
    errors: {},
    declined: null,
    durationMs: 0,
    changedSlugs: []
  };
  const done = () => {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  };

  if (!deps.enabled) {
    stats.declined = 'disabled';
    return done();
  }

  const slugs = collectRatingSlugs(sources);
  stats.visible = slugs.length;
  if (!slugs.length) return done();

  const candidates = await deps.listCandidates(slugs, deps.batchLimit);
  stats.selected = candidates.length;
  if (!candidates.length) return done();

  // Claimed up front, before any request goes out, so two workers cannot read
  // the same remaining count and jointly blow past the daily cap.
  const budget = await deps.reserveBudget(candidates.length);
  stats.reserved = budget.granted;
  if (!budget.granted) {
    stats.declined = 'budget-exhausted';
    return done();
  }

  const batch = candidates.slice(0, budget.granted);
  let quotaHit = false;

  const results = await mapLimit(batch, deps.concurrency, async (movie) => {
    if (quotaHit) return null;

    let imdbId = movie.imdb_id || movie.omdb_imdb_id || null;
    if (!imdbId) {
      // Free of OMDb quota, so it is always worth trying before giving up.
      if (!deps.tmdbEnabled || !movie.tmdb_id) {
        stats.noId += 1;
        await deps.recordMiss(movie.id, 'no-tmdb-id').catch(() => {});
        return null;
      }
      try {
        imdbId = await deps.resolveExternalId({
          tmdbId: movie.tmdb_id,
          mediaType: tmdbMediaType(movie)
        });
      } catch (error) {
        console.warn('[worker] TMDB external_ids failed for ' + movie.canonical_slug, error.message);
        imdbId = null;
      }
      if (!imdbId) {
        stats.noId += 1;
        await deps.recordMiss(movie.id, 'no-imdb-id').catch(() => {});
        return null;
      }
      stats.lifted += 1;
    }

    try {
      const result = await deps.fetchOmdb(imdbId);
      stats.spent += 1;
      if (result.status !== 'matched') {
        stats.unmatched += 1;
        await deps.recordMiss(movie.id, 'unmatched', imdbId).catch(() => {});
        return null;
      }
      stats.matched += 1;
      if (result.tomatometer !== null) stats.tomato += 1;
      await deps.recordScores(movie.id, result);
      // Only a row whose rendered output can actually change is worth pushing
      // through cache invalidation; a match with no usable score is not.
      return result.tomatometer !== null || result.imdbRating !== null
        ? movie.canonical_slug
        : null;
    } catch (error) {
      if (error?.code === 'OMDB_QUOTA') {
        quotaHit = true;
        stats.declined = 'quota: ' + error.message;
        return null;
      }
      stats.spent += 1;
      const reason = error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error);
      stats.errors[reason] = (stats.errors[reason] || 0) + 1;
      await deps.recordMiss(movie.id, 'error', imdbId).catch(() => {});
      return null;
    }
  });

  if (quotaHit) {
    // The key is spent for the rest of the UTC day. Drain the local allowance
    // instead of refunding, so the next cycle does not walk into another 401.
    await deps.reserveBudget(budget.ceiling).catch(() => {});
  } else {
    await deps.releaseBudget(budget.granted - stats.spent).catch(() => {});
  }

  stats.changedSlugs = results.filter(Boolean);
  return done();
}

export function formatOmdbStats(stats) {
  const parts = [
    'visible=' + stats.visible,
    'selected=' + stats.selected,
    'reserved=' + stats.reserved,
    'spent=' + stats.spent,
    'matched=' + stats.matched,
    'tomato=' + stats.tomato,
    'unmatched=' + stats.unmatched,
    'tmdbLift=' + stats.lifted,
    'noId=' + stats.noId,
    'durationMs=' + stats.durationMs
  ];
  if (stats.declined) parts.push('declined=' + stats.declined);
  const errors = Object.entries(stats.errors);
  if (errors.length) {
    parts.push('errors=' + errors.map(([reason, count]) => reason + 'x' + count).join(','));
  }
  return parts.join(' ');
}
