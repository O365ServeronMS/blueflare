import { createHash } from 'node:crypto';
import { closeCache, getOrBuild, invalidateResponseKeys } from './cache.js';
import { config } from './config.js';
import { closeDatabase, migrate } from './db.js';
import { normalizeKkphim, normalizeNguonc } from './normalize.js';
import { KkphimProvider } from './providers/KkphimProvider.js';
import { NguoncProvider } from './providers/NguoncProvider.js';
import {
  getCrawlCheckpoint,
  getHeroTrendingRefreshState,
  listTmdbImageCandidates,
  recordTmdbImageFailure,
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
import { fetchTrendingMovieIds, fetchVerifiedTmdbImages } from './tmdb.js';
import { buildHome } from './viewmodels.js';

async function revalidateFrontend(tags) {
  if (!config.frontendRevalidateSecret || !tags.length) return;
  try {
    const response = await fetch(config.frontendRevalidateUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-blueflare-revalidate': config.frontendRevalidateSecret
      },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) console.warn('[worker] frontend revalidation failed status=' + response.status);
  } catch (error) {
    console.warn('[worker] frontend revalidation unavailable', error.message);
  }
}

const providers = [new NguoncProvider(), new KkphimProvider()];
let stopping = false;

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner())
  );
  return results;
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
    }
  } catch (error) {
    await recordCrawlCheckpointFailure(provider.name, 'backfill', error).catch(() => {});
    throw error;
  }
  return { imported, failed, status, nextPage: page, changedSlugs };
}

async function syncProvider(provider) {
  const started = Date.now();
  let imported = 0;
  let failed = 0;
  let lastStatus = 200;
  const changedSlugs = [];
  try {
    const head = await syncHead(provider);
    imported += head.imported;
    failed += head.failed;
    changedSlugs.push(...head.changedSlugs);
    lastStatus = head.status;
    const backfill = await syncBackfill(provider);
    imported += backfill.imported;
    failed += backfill.failed;
    changedSlugs.push(...backfill.changedSlugs);
    lastStatus = backfill.status || lastStatus;
    await recordProviderSuccess(provider.name, Date.now() - started, lastStatus, failed);
    console.log(
      '[worker] ' + provider.name + ' head+backfill imported=' + imported +
      ' detailFailures=' + failed + ' durationMs=' + (Date.now() - started)
    );
    return { imported, failed, changedSlugs };
  } catch (error) {
    await recordProviderFailure(provider.name, error).catch(() => {});
    console.error('[worker] ' + provider.name + ' sync failed', error);
    return { imported, failed: failed + 1, error, changedSlugs };
  }
}


async function refreshHeroTrendingIfDue() {
  if (!config.tmdbApiKey) return;
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

async function syncCycle() {
  const results = [];
async function refreshTmdbImages() {
  if (!config.tmdbApiKey) return [];
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

  for (const provider of providers) {
    if (stopping) break;
    results.push(await syncProvider(provider));
  }

  const imported = results.reduce((sum, result) => sum + result.imported, 0);
  const tmdbImageSlugs = await refreshTmdbImages();
  const changedSlugs = [...new Set([...results.flatMap((result) => result.changedSlugs), ...tmdbImageSlugs])];
  if (changedSlugs.length > 0) {
    const changedMovies = await getMovieInvalidationDimensions(changedSlugs).catch((error) => {
      console.warn("[worker] taxonomy invalidation lookup failed", error.message);
      return [];
    });
    const keys = ['home'];
    for (const type of ['phim-moi-cap-nhat', 'phim-le', 'phim-bo', 'hoat-hinh', 'tv-shows']) {
      for (let currentPage = 1; currentPage <= 3; currentPage += 1) keys.push('list:' + type + ':' + currentPage);
    }
    for (const movieSlug of changedSlugs) keys.push('movie:' + movieSlug);
    for (const movie of changedMovies) {
      for (const field of [movie.genres, movie.countries]) {
        for (const item of Array.isArray(field) ? field : []) {
          const slug = String(item?.slug || "").trim().toLowerCase();
          if (!slug) continue;
          const prefix = field === movie.genres ? 'genre:' : 'country:';
          for (let currentPage = 1; currentPage <= 3; currentPage += 1) keys.push(prefix + slug + ':' + currentPage);
        }
      }
    }
    await invalidateResponseKeys(keys);
    const tags = ['home', 'list'];
    for (const type of ['phim-moi-cap-nhat', 'phim-le', 'phim-bo', 'hoat-hinh', 'tv-shows']) tags.push('list:' + type);
    for (let currentPage = 1; currentPage <= 3; currentPage += 1) tags.push('page:' + currentPage);
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
    console.log('[worker] resource invalidation changed=' + changedSlugs.length + ' home precomputed');
  } else {
    console.warn('[worker] no canonical changes; existing cache remains active');
  }
}

await migrate();

function stop(signal) {
  console.log('[worker] received ' + signal + ', stopping after current operation');
  stopping = true;
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

while (!stopping) {
  const started = Date.now();
  await refreshHeroTrendingIfDue();
  if (!stopping) await syncCycle();
  const elapsed = Date.now() - started;
  const delay = Math.max(1000, config.syncIntervalMs - elapsed);
  if (stopping) break;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

await Promise.allSettled([closeCache(), closeDatabase()]);
