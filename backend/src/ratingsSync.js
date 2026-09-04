import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { fetchOmdbByImdbId, omdbKeyId } from './omdb.js';
import { fetchTmdbExternalIds } from './tmdb.js';

/**
 * OMDb score sync.
 *
 * OMDb's free tier allows 1000 requests per key per UTC day against a catalog
 * of ~49k rows, so this cannot be a crawl — a full pass would take days and
 * spend most of it on titles nobody opened. It is demand-driven instead, in the
 * same shape as `prewarm.js`: read the viewmodels the API is already serving,
 * take the rows a visitor is about to see, and spend the allowance on those.
 *
 * The allowance itself is a *pool of keys* (OMDB_API_KEY + OMDB_API_KEYS),
 * spent strictly in order. Each key has its own daily counter in Postgres, and
 * a key that answers 401 mid-batch is drained locally while its unfinished rows
 * roll over to the next key in the same pass — a quota boundary costs the rows
 * nothing but a retry on the following key.
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
  const apiKeys = (options.apiKeys ?? config.omdbApiKeys)
    .map((key) => ({ key, id: omdbKeyId(key) }));
  const deps = {
    ...(await resolveRepositoryDeps(options)),
    fetchOmdb: options.fetchOmdb || fetchOmdbByImdbId,
    resolveExternalId: options.resolveExternalId || fetchTmdbExternalIds,
    batchLimit: options.batchLimit ?? config.omdbBatchLimit,
    concurrency: options.concurrency ?? config.omdbConcurrency,
    enabled: options.enabled ?? (config.omdbEnabled && apiKeys.length > 0),
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
    keysTotal: apiKeys.length,
    keysTried: 0,
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

  const changed = [];
  // Rows still waiting for an OMDb request. A row leaves this queue by being
  // resolved (scored, missed, errored) — never by a key running dry: those
  // carry over to the next key in the same pass.
  let pending = candidates;

  for (const apiKey of apiKeys) {
    if (!pending.length) break;

    // Claimed up front, before any request goes out, so two workers cannot
    // read the same remaining count and jointly blow past this key's cap.
    const budget = await deps.reserveBudget(apiKey.id, pending.length);
    if (!budget.granted) continue;
    stats.keysTried += 1;
    stats.reserved += budget.granted;

    const batch = pending.slice(0, budget.granted);
    const rest = pending.slice(budget.granted);
    const carried = [];
    let localSpent = 0;
    let quotaHit = false;

    const results = await mapLimit(batch, deps.concurrency, async (movie) => {
      if (quotaHit) {
        carried.push(movie);
        return null;
      }

      // `_resolvedImdbId` survives a carry-over, so a row that rode a quota
      // boundary does not pay for (or double-count) a second TMDB lookup.
      let imdbId = movie.imdb_id || movie.omdb_imdb_id || movie._resolvedImdbId || null;
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
        movie._resolvedImdbId = imdbId;
        stats.lifted += 1;
      }

      try {
        const result = await deps.fetchOmdb(imdbId, { apiKey: apiKey.key });
        stats.spent += 1;
        localSpent += 1;
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
          carried.push(movie);
          return null;
        }
        stats.spent += 1;
        localSpent += 1;
        const reason = error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error);
        stats.errors[reason] = (stats.errors[reason] || 0) + 1;
        await deps.recordMiss(movie.id, 'error', imdbId).catch(() => {});
        return null;
      }
    });
    changed.push(...results.filter(Boolean));

    if (quotaHit) {
      // This key is spent for the rest of the UTC day. Drain its local
      // allowance instead of refunding, so the next cycle does not walk into
      // another 401 — and hand its unfinished rows to the next key.
      await deps.reserveBudget(apiKey.id, budget.ceiling).catch(() => {});
      pending = [...carried, ...rest];
      continue;
    }
    await deps.releaseBudget(apiKey.id, budget.granted - localSpent).catch(() => {});
    pending = rest;
  }

  if (pending.length && !stats.declined) stats.declined = 'budget-exhausted';
  stats.changedSlugs = changed;
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
    'keys=' + stats.keysTried + '/' + stats.keysTotal,
    'durationMs=' + stats.durationMs
  ];
  if (stats.declined) parts.push('declined=' + stats.declined);
  const errors = Object.entries(stats.errors);
  if (errors.length) {
    parts.push('errors=' + errors.map(([reason, count]) => reason + 'x' + count).join(','));
  }
  return parts.join(' ');
}
