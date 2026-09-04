import { createHash } from 'node:crypto';
import {
  closeCache,
  getOrBuild,
  invalidateResponseKeys,
  writeWorkerHeartbeat
} from './cache.js';
import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { closeDatabase, migrate } from './db.js';
import { revalidateFrontend } from './frontendRevalidation.js';
import { normalizeKkphim, normalizeNguonc } from './normalize.js';
import { KkphimProvider } from './providers/KkphimProvider.js';
import { NguoncProvider } from './providers/NguoncProvider.js';
import {
  getCrawlCheckpoint,
  getHeroTrendingRefreshState,
  listTmdbImageCandidates,
  listTmdbImageFallbackCandidates,
  recordTmdbImageFailure,
  recordTmdbImageFallback,
  recordTmdbImageFallbackMiss,
  recordTmdbImages,
  recordCrawlCheckpointFailure,
  recordHeroTrendingRefreshFailure,
  recordProviderFailure,
  recordProviderSuccess,
  replaceHeroTrendingSnapshot,
  resolveTrendingMovieCandidates,
  saveCrawlCheckpoint,
  upsertCanonical,
  withHeroTrendingRefreshLock,
  getMovieInvalidationDimensions
} from './repository.js';
import { formatPrewarmStats, prewarmImages } from './prewarm.js';
import { formatMdblistStats, syncMdblistRatings } from './mdblistRatingsSync.js';
import { fetchTrendingMovieIds, fetchVerifiedTmdbImages, searchTmdbImagesByTitle } from './tmdb.js';
import { buildHome, buildList } from './viewmodels.js';
import { runWorkerLoop } from './workerLoop.js';

const providers = [new NguoncProvider(), new KkphimProvider()];
let stopping = false;
let lastBackfillRunAt = 0;

function providersFor(names) {
  const allow = new Set(names.map((name) => String(name).toLowerCase()));
  return providers.filter((provider) => allow.has(provider.name.toLowerCase()));
}

function summaryFallback(provider, item) {
  return provider.name === 'nguonc'
    ? normalizeNguonc({ movie: item })
    : normalizeKkphim({ movie: item, episodes: [] });
}

function pageHash(items) {
  const sourceIds = items.map((item) => (
    item?.id || item?._id || item?.slug || ''
  )).join('\n');
  return createHash('sha256').update(sourceIds).digest('hex');
}

function totalPages(payload) {
  const value = payload?.paginate?.total_page || payload?.pagination?.totalPages ||
    payload?.data?.pagination?.totalPages || payload?.data?.paginate?.total_page;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function syncPage(provider, page) {
  const list = await provider.syncLatest(page);
  const items = provider.listItems(list.data);
  let imported = 0;
  let failed = 0;
  const changedSlugs = [];

  await mapLimit(items, config.syncConcurrency, async (item) => {
    let normalized;
    try {
      const detail = await provider.detail(item.slug);
      normalized = detail.normalized;
    } catch (error) {
      failed += 1;
      console.warn(
        '[worker] ' + provider.name + ' detail failed for ' + item.slug,
        error.message
      );
      normalized = summaryFallback(provider, item);
    }
    try {
      const result = await upsertCanonical(normalized);
      if (result.changed) changedSlugs.push(result.movie.canonical_slug);
      imported += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        '[worker] ' + provider.name + ' upsert failed for ' + item.slug,
        error.message
      );
    }
  });

  return {
    imported,
    failed,
    status: list.status,
    itemCount: items.length,
    pageHash: pageHash(items),
    totalPages: totalPages(list.data),
    changedSlugs
  };
}

async function syncHead(provider) {
  let imported = 0;
  let failed = 0;
  let status = 200;
  const changedSlugs = [];
  for (let page = 1; page <= config.syncPagesPerRun; page += 1) {
    if (stopping) break;
    const result = await syncPage(provider, page);
    imported += result.imported;
    failed += result.failed;
    changedSlugs.push(...result.changedSlugs);
    status = result.status;
    if (!result.itemCount) break;
  }
  return { imported, failed, status, changedSlugs };
}

async function syncBackfill(provider) {
  if (!config.backfillEnabled || stopping) return { imported: 0, failed: 0, status: 200, changedSlugs: [] };

  const startPage = config.backfillStartPage || (config.syncPagesPerRun + 1);
  const checkpoint = await getCrawlCheckpoint(provider.name, 'backfill', startPage);
  if (checkpoint.completed_at) return { imported: 0, failed: 0, status: 200, completed: true, changedSlugs: [] };

  let imported = 0;
  let failed = 0;
  let status = 200;
  const changedSlugs = [];
  let page = checkpoint.next_page;
  try {
    for (let index = 0; index < config.backfillPagesPerRun; index += 1) {
      if (stopping) break;
      if (config.backfillEndPage > 0 && page > config.backfillEndPage) {
        await saveCrawlCheckpoint(provider.name, 'backfill', { nextPage: page, completed: true });
        return { imported, failed, status, completed: true, changedSlugs };
      }
      const result = await syncPage(provider, page);
      imported += result.imported;
      failed += result.failed;
      changedSlugs.push(...result.changedSlugs);
      status = result.status;
      const completed = !result.itemCount || Boolean(result.totalPages && page >= result.totalPages);
      await saveCrawlCheckpoint(provider.name, 'backfill', {
        nextPage: page + 1,
        pageHash: result.pageHash,
        totalPages: result.totalPages,
        completed
      });
      if (completed) return { imported, failed, status, completed: true, changedSlugs };
      page += 1;
      if (config.backfillCooldownMs > 0 && index < config.backfillPagesPerRun - 1 && !stopping) {
        await new Promise((resolve) => setTimeout(resolve, config.backfillCooldownMs));
      }
    }
  } catch (error) {
    await recordCrawlCheckpointFailure(provider.name, 'backfill', error).catch(() => {});
    throw error;
  }
  return { imported, failed, status, nextPage: page, changedSlugs };
}

async function syncProvider(provider) {
  const started = Date.now();
  try {
    const head = await syncHead(provider);
    await recordProviderSuccess(provider.name, Date.now() - started, head.status, head.failed);
    console.log(
      '[worker] ' + provider.name + ' head imported=' + head.imported +
      ' detailFailures=' + head.failed + ' durationMs=' + (Date.now() - started)
    );
    return head;
  } catch (error) {
    await recordProviderFailure(provider.name, error).catch(() => {});
    console.error('[worker] ' + provider.name + ' sync failed', error);
    return { imported: 0, failed: 1, error, changedSlugs: [] };
  }
}

async function runBackfillPass() {
  const results = [];
  for (const provider of providersFor(config.backfillProviders)) {
    if (stopping) break;
    const started = Date.now();
    try {
      const result = await syncBackfill(provider);
      results.push(result);
      console.log(
        '[worker] ' + provider.name + ' backfill imported=' + result.imported +
        ' detailFailures=' + result.failed + ' durationMs=' + (Date.now() - started)
      );
    } catch (error) {
      console.error('[worker] ' + provider.name + ' backfill failed', error);
    }
  }
  return results;
}

async function refreshHeroTrendingIfDue() {
  if (!config.tmdbEnabled || !config.tmdbApiKey) return;
  const state = await getHeroTrendingRefreshState();
  const lastSuccessAt = Date.parse(state?.last_success_at || '');
  if (Number.isFinite(lastSuccessAt) && Date.now() - lastSuccessAt < config.heroTrendingRefreshMs) return;

  try {
    const refreshed = await withHeroTrendingRefreshLock(async () => {
      const lockedState = await getHeroTrendingRefreshState();
      const lockedLastSuccessAt = Date.parse(lockedState?.last_success_at || '');
      if (Number.isFinite(lockedLastSuccessAt) && Date.now() - lockedLastSuccessAt < config.heroTrendingRefreshMs) return;

      let candidateIds = [];
      let matches = [];
      try {
        candidateIds = await fetchTrendingMovieIds();
        matches = await resolveTrendingMovieCandidates(candidateIds, config.heroTrendingLimit);
        if (matches.length !== config.heroTrendingLimit) {
          throw new Error('TMDB Trending matched ' + matches.length + ' of ' + config.heroTrendingLimit + ' playable catalog movies');
        }
        await replaceHeroTrendingSnapshot(matches, { candidateCount: candidateIds.length });
        await invalidateResponseKeys(['home']);
        await revalidateFrontend(['home']);
        await getOrBuild('home', buildHome, { ttl: config.responseCacheTtlSeconds });
        console.log('[worker] hero trending refreshed candidates=' + candidateIds.length + ' matched=' + matches.length);
      } catch (error) {
        await recordHeroTrendingRefreshFailure(error, {
          candidateCount: candidateIds.length,
          matchedCount: matches.length
        }).catch((recordError) => console.warn('[worker] hero trending failure state write failed', recordError.message));
        throw error;
      }
    });
    if (!refreshed) console.log('[worker] hero trending refresh skipped; lock held by another worker');
  } catch (error) {
    console.warn('[worker] hero trending refresh failed', error.message);
  }
}

async function refreshTmdbImages() {
  if (!config.tmdbEnabled || !config.tmdbImageSyncEnabled || !config.tmdbApiKey) return [];
  const candidates = await listTmdbImageCandidates();
  const results = await mapLimit(candidates, config.tmdbImageSyncConcurrency, async (movie) => {
    try {
      const images = await fetchVerifiedTmdbImages({
        tmdbId: movie.tmdb_id,
        mediaType: movie.tmdb_media_type,
        seasonNumber: movie.tmdb_season_number
      });
      return await recordTmdbImages(movie.id, images);
    } catch (error) {
      console.warn('[worker] TMDB image verification failed for ' + movie.canonical_slug, error.message);
      await recordTmdbImageFailure(movie.id, error);
      return null;
    }
  });
  return results.filter(Boolean).map((movie) => movie.canonical_slug);
}

/**
 * Borrow artwork for rows the providers left without any image.
 *
 * Separate from `refreshTmdbImages()` because these rows carry no tmdb_id to
 * verify against: identity is guessed from the title and only an unambiguous
 * exact match is accepted, so most candidates are expected to be declined.
 */
async function refreshTmdbImageFallbacks() {
  if (!config.tmdbEnabled || !config.tmdbImageFallbackEnabled || !config.tmdbApiKey) return [];
  const candidates = await listTmdbImageFallbackCandidates();
  if (!candidates.length) return [];

  let matched = 0;
  const results = await mapLimit(candidates, config.tmdbImageFallbackConcurrency, async (movie) => {
    try {
      const { match, status } = await searchTmdbImagesByTitle({
        title: movie.original_title,
        mediaType: movie.media_type
      });
      if (!match) {
        await recordTmdbImageFallbackMiss(movie.id, status);
        return null;
      }
      matched += 1;
      return await recordTmdbImageFallback(movie.id, match);
    } catch (error) {
      console.warn('[worker] TMDB image fallback failed for ' + movie.canonical_slug, error.message);
      await recordTmdbImageFallbackMiss(movie.id, 'error').catch(() => {});
      return null;
    }
  });
  console.log('[worker] tmdb image fallback checked=' + candidates.length + ' matched=' + matched);
  return results.filter(Boolean).map((movie) => movie.canonical_slug);
}

/**
 * Warm the image cache for the catalog surfaces users land on first.
 *
 * The payloads come from the same viewmodels the API serves, so the prewarmer
 * asks for exactly the asset URLs the next visitor will request - no second
 * copy of the thumb/poster precedence rules to drift out of sync. Reading them
 * through `getOrBuild` also leaves the list responses warm in Valkey.
 */
async function prewarmHotImages() {
  if (!config.imagePrewarmEnabled) return;
  const payloads = [];
  try {
    payloads.push((await getOrBuild('home', buildHome, { ttl: config.responseCacheTtlSeconds })).data);
    for (const type of config.invalidateListTypes) {
      for (let currentPage = 1; currentPage <= config.imagePrewarmPageDepth; currentPage += 1) {
        const key = 'list:' + type + ':' + currentPage;
        const result = await getOrBuild(key, () => buildList(type, currentPage), {
          ttl: config.responseCacheTtlSeconds
        });
        payloads.push(result.data);
      }
    }
  } catch (error) {
    console.warn('[worker] image prewarm could not read catalog payloads', error.message);
    return;
  }

  const stats = await prewarmImages(payloads);
  const line = '[worker] image prewarm ' + formatPrewarmStats(stats);
  if (stats.declined || stats.failed) console.warn(line);
  else console.log(line);
}

async function syncCycle() {
  const headResults = [];
  if (config.syncEnabled) {
    for (const provider of providersFor(config.syncProviders)) {
      if (stopping) break;
      headResults.push(await syncProvider(provider));
    }
  }

  let backfillResults = [];
  if (config.backfillEnabled && !stopping && Date.now() - lastBackfillRunAt >= config.backfillIntervalMs) {
    lastBackfillRunAt = Date.now();
    backfillResults = await runBackfillPass();
  }

  const tmdbImageSlugs = await refreshTmdbImages();
  const tmdbFallbackSlugs = await refreshTmdbImageFallbacks().catch((error) => {
    console.warn('[worker] tmdb image fallback pass failed', error.message);
    return [];
  });
  const changedSlugs = [...new Set([
    ...headResults.flatMap((result) => result.changedSlugs),
    ...backfillResults.flatMap((result) => result.changedSlugs),
    ...tmdbImageSlugs,
    ...tmdbFallbackSlugs
  ])];
  if (changedSlugs.length > 0) {
    await invalidateForSlugs(changedSlugs);
    console.log('[worker] resource invalidation changed=' + changedSlugs.length + ' home precomputed');
  } else {
    console.warn('[worker] no canonical changes; existing cache remains active');
  }

  const ratingChangedSlugs = [];
  if (!stopping) ratingChangedSlugs.push(...await refreshMdblistRatings());
  if (ratingChangedSlugs.length) {
    await invalidateForSlugs([...new Set(ratingChangedSlugs)]).catch((error) => {
      console.warn('[worker] rating invalidation failed', error.message);
    });
  }
  if (!stopping) await prewarmHotImages();
}

/**
 * Drop every cached response and render tag a set of changed movies can appear
 * in, then rebuild the home payload.
 *
 * Shared by provider sync and both rating passes so there is one
 * definition of that fan-out. Note the key set is intentionally not keyed by
 * which slugs changed: list, genre and country pages are paginated windows over
 * the whole catalog, so a single changed row can move any of them.
 */
async function invalidateForSlugs(changedSlugs) {
  const changedMovies = await getMovieInvalidationDimensions(changedSlugs).catch((error) => {
    console.warn("[worker] taxonomy invalidation lookup failed", error.message);
    return [];
  });
  const keys = ['home'];
  for (const type of config.invalidateListTypes) {
    for (let currentPage = 1; currentPage <= config.invalidatePageDepth; currentPage += 1) keys.push('list:' + type + ':' + currentPage);
  }
  for (const movieSlug of changedSlugs) keys.push('movie:' + movieSlug);
  for (const movie of changedMovies) {
    for (const field of [movie.genres, movie.countries]) {
      for (const item of Array.isArray(field) ? field : []) {
        const slug = String(item?.slug || "").trim().toLowerCase();
        if (!slug) continue;
        const prefix = field === movie.genres ? 'genre:' : 'country:';
        for (let currentPage = 1; currentPage <= config.invalidatePageDepth; currentPage += 1) keys.push(prefix + slug + ':' + currentPage);
      }
    }
  }
  await invalidateResponseKeys(keys);
  const tags = ['home', 'list'];
  for (const type of config.invalidateListTypes) tags.push('list:' + type);
  for (let currentPage = 1; currentPage <= config.invalidatePageDepth; currentPage += 1) tags.push('page:' + currentPage);
  tags.push(...changedSlugs.map((movieSlug) => 'movie:' + movieSlug));
  for (const movie of changedMovies) {
    for (const field of [movie.genres, movie.countries]) {
      for (const item of Array.isArray(field) ? field : []) {
        const slug = String(item?.slug || "").trim().toLowerCase();
        if (!slug) continue;
        tags.push((field === movie.genres ? 'category:' : 'country:') + slug);
      }
    }
  }
  await revalidateFrontend([...new Set(tags)]);
  await getOrBuild('home', buildHome, { ttl: config.responseCacheTtlSeconds });
}

/**
 * Attach MDBList critic/audience scores to the approved visible surfaces.
 *
 * Reads the same viewmodels the API serves, exactly like `prewarmHotImages()`
 * below, so there is no second copy of "what is on the home page" to drift.
 * Runs before the prewarm pass because it invalidates the list payloads the
 * prewarmer then re-reads, which leaves the prewarmer warming the newest data.
 */
async function refreshMdblistRatings() {
  if (!config.mdblistEnabled || !config.mdblistApiKeys.length) return [];

  const sources = [];
  try {
    for (const bucket of config.mdblistRatingTypes) {
      if (bucket === 'trending') {
        const home = await getOrBuild('home', buildHome, { ttl: config.responseCacheTtlSeconds });
        sources.push({ bucket, payload: home.data });
        continue;
      }
      for (let currentPage = 1; currentPage <= config.mdblistPageDepth; currentPage += 1) {
        const key = 'list:' + bucket + ':' + currentPage;
        const result = await getOrBuild(key, () => buildList(bucket, currentPage), {
          ttl: config.responseCacheTtlSeconds
        });
        sources.push({ bucket, payload: result.data });
      }
    }
  } catch (error) {
    console.warn('[worker] mdblist ratings could not read catalog payloads', error.message);
    return [];
  }

  let stats;
  try {
    stats = await syncMdblistRatings(sources);
  } catch (error) {
    console.error('[worker] mdblist ratings pass failed', error);
    return [];
  }

  const line = '[worker] mdblist ratings ' + formatMdblistStats(stats);
  if (stats.declined || Object.keys(stats.errors).length) console.warn(line);
  else console.log(line);
  return stats.changedSlugs;
}

const stopController = new AbortController();
function stop(signal) {
  console.log('[worker] received ' + signal + ', stopping after current operation');
  stopping = true;
  stopController.abort();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

try {
  await runWorkerLoop({
    initialize: migrate,
    runCycle: async () => {
      await refreshHeroTrendingIfDue();
      if (!stopping) await syncCycle();
    },
    writeHeartbeat: writeWorkerHeartbeat,
    intervalMs: config.syncIntervalMs,
    signal: stopController.signal
  });
} catch (error) {
  console.error('[worker] fatal worker failure', error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([closeCache(), closeDatabase()]);
}
