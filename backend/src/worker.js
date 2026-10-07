import { createHash } from 'node:crypto';
import {
  closeCache,
  getOrBuild,
  invalidateResponseKeys,
  writeWorkerHeartbeat
} from './cache.js';
import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { syncTmdbReviews } from './tmdbReviewsSync.js';
import { syncReviewTranslations } from './reviewTranslateSync.js';
import { closeDatabase, migrate } from './db.js';
import { revalidateFrontend } from './frontendRevalidation.js';
import { normalizeKkphim, normalizeNguonc } from './normalize.js';
import { collectHeroTrending } from './heroTrending.js';
import { unchangedSlugs } from './syncSkip.js';
import { KkphimProvider } from './providers/KkphimProvider.js';
import { NguoncProvider } from './providers/NguoncProvider.js';
import {
  getCrawlCheckpoint,
  getHeroTrendingRefreshState,
  listTmdbImageCandidates,
  listTmdbImageFallbackCandidates,
  listTmdbLookupCandidates,
  listTmdbRecommendationCandidates,
  listTmdbCreditCandidates,
  listTmdbMatchCandidates,
  correctGuessedLookupIds,
  recordTmdbMatch,
  recordTmdbMatchFailure,
  recordTmdbLookup,
  recordTmdbRecommendations,
  recordTmdbCredits,
  recordTmdbCreditsFailure,
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
  touchSourcesSeen,
  resetCompletedCheckpoint,
  listStaleSources,
  recordSourceNotFound,
  markSourceUnavailable,
  countMoviesWithoutAvailableSource,
  countUnseenSince,
  countMdblistOverdue,
  withHeroTrendingRefreshLock,
  getMovieInvalidationDimensions,
  getMdblistBackfillCursor,
  saveMdblistBackfillCursor,
  listStoredSourceStates,
  healImageSourcesFromItems,
  healImageSourcesFromAlternate,
  loadImageHostHealth,
  saveImageHostHealth,
  sampleImageSourceUrls,
  purgeDeadHostImages
} from './repository.js';
import { formatStaleStats, refreshStaleSources } from './staleSources.js';
import { mergeAlerts } from './duplicateMerge.js';
import { mergeDuplicate, planCatalogMerges } from './duplicateMergeRepository.js';
import { formatPrewarmStats, prewarmImages } from './prewarm.js';
import { createLocalImageStore } from './imageStore.js';
import { deadImageHosts, setLearnedDeadHosts } from './imageHostRegistry.js';
import { probeUrl } from './imageHostHealth.js';
import { runImageHostCheck } from './imageHostCheck.js';
import { findCastVerifiedMatch } from './tmdbMatch.js';
import { refreshTmdbAiMatches } from './tmdbMatchAiSync.js';
import { aiLoopEnabled, runTmdbMatchAiLoop } from './tmdbMatchAiLoop.js';
import { promoteVerifiedMatches } from './tmdbIdentity.js';
import { backfillMdblistRatings, formatMdblistStats, syncMdblistRatings } from './mdblistRatingsSync.js';
import {
  fetchTmdbCredits,
  fetchTmdbRecommendations,
  fetchTrendingMovieIds,
  fetchVerifiedTmdbImages,
  searchTmdbIdByTitle,
  searchTmdbImagesByTitle
} from './tmdb.js';
import { buildHome, buildList } from './viewmodels.js';
import { reviewsInvalidationKeys } from './reviewOrder.js';
import { runWorkerLoop } from './workerLoop.js';

const providers = [new NguoncProvider(), new KkphimProvider()];
let stopping = false;
let lastBackfillRunAt = 0;
let lastMdblistBackfillRunAt = 0;
let mdblistBackfillResetDone = false;

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
  let skipped = 0;
  const changedSlugs = [];
  const stored = await listStoredSourceStates(provider.name, items.map((item) => item.slug));
  const unchanged = unchangedSlugs(items, stored);
  const hasGoodSource = new Set(stored.map((row) => row.provider_slug));
  // Unchanged items are skipped below, so this is what keeps their last_seen_at fresh.
  await touchSourcesSeen(provider.name, items.map((item) => item.slug)).catch((error) => {
    console.warn('[worker] ' + provider.name + ' touch last_seen_at failed', error.message);
  });

  await mapLimit(items, config.syncConcurrency, async (item) => {
    if (unchanged.has(item.slug)) {
      skipped += 1;
      return;
    }
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
      // Fallback tóm tắt không có stream: không được ghi đè nguồn đã có dữ liệu tốt.
      if (hasGoodSource.has(item.slug)) return;
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
    skipped,
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
  let skipped = 0;
  let status = 200;
  const changedSlugs = [];
  for (let page = 1; page <= config.syncPagesPerRun; page += 1) {
    if (stopping) break;
    const result = await syncPage(provider, page);
    imported += result.imported;
    failed += result.failed;
    skipped += result.skipped;
    changedSlugs.push(...result.changedSlugs);
    status = result.status;
    if (!result.itemCount) break;
  }
  return { imported, failed, skipped, status, changedSlugs };
}

async function syncBackfill(provider) {
  if (!config.backfillEnabled || stopping) return { imported: 0, failed: 0, status: 200, changedSlugs: [] };

  const startPage = config.backfillStartPage || (config.syncPagesPerRun + 1);
  const checkpoint = await getCrawlCheckpoint(provider.name, 'backfill', startPage);
  if (checkpoint.completed_at) {
    const cycleMs = config.sweepCycleDays * 24 * 60 * 60 * 1000;
    const due = cycleMs > 0 && Date.now() - new Date(checkpoint.completed_at).getTime() >= cycleMs;
    const reset = due && await resetCompletedCheckpoint(provider.name, 'backfill', startPage, cycleMs);
    if (!reset) return { imported: 0, failed: 0, status: 200, completed: true, changedSlugs: [] };
    console.log('[worker] ' + provider.name + ' backfill sweep restarted at page ' + startPage +
      ' (completed_at older than ' + config.sweepCycleDays + 'd)');
    checkpoint.next_page = startPage;
  }

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
      ' skippedUnchanged=' + head.skipped +
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

async function refreshStaleSourcesPass() {
  if (config.staleSourceMode === 'off' || stopping) return [];
  const stats = await refreshStaleSources({
    mode: config.staleSourceMode,
    providers: providersFor(config.syncProviders),
    deps: {
      listStale: listStaleSources,
      mapLimit,
      upsert: upsertCanonical,
      recordNotFound: recordSourceNotFound,
      markUnavailable: markSourceUnavailable,
      countNoSource: countMoviesWithoutAvailableSource,
      countUnseen: countUnseenSince
    },
    settings: {
      staleMs: config.staleSourceDays * 24 * 60 * 60 * 1000,
      batch: config.staleSourceBatch,
      concurrency: Math.min(2, config.syncConcurrency)
    },
    isStopping: () => stopping
  });
  const line = '[worker] stale source refresh ' + formatStaleStats(stats);
  if (stats.transient || stats.marked) console.warn(line);
  else console.log(line);
  return stats.changedSlugs;
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
        ({ candidateIds, matches } = await collectHeroTrending({
          fetchIds: (options) => fetchTrendingMovieIds(options),
          resolve: resolveTrendingMovieCandidates,
          limit: config.heroTrendingLimit,
          pages: config.heroTrendingCandidatePages,
          maxPages: config.heroTrendingMaxCandidatePages
        }));
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

/**
 * Daily: probe each allowlisted image host with a few real stored URLs, drop hosts
 * that stay dead from the effective allowlist, and clear their links from movies.
 * Purging waits for image-heal to finish so heal can still swap in fresh URLs first.
 */
async function checkImageHosts() {
  if (!config.imageHostCheckEnabled || stopping) return [];
  const heal = await getCrawlCheckpoint('nguonc', 'image-heal', 1);
  const store = createLocalImageStore(config.imageCacheDir);
  const result = await runImageHostCheck({
    hosts: config.imageAllowedHosts,
    settings: {
      intervalMs: config.imageHostCheckIntervalMs,
      samples: config.imageHostCheckSamples,
      deadAfter: config.imageHostDeadAfterChecks,
      purgeAllowed: !config.imageHealEnabled || Boolean(heal.completed_at)
    },
    deps: {
      loadHealth: loadImageHostHealth,
      saveHealth: saveImageHostHealth,
      sampleUrls: sampleImageSourceUrls,
      probe: (url) => probeUrl(url, { timeoutMs: config.requestTimeoutMs }),
      setDead: setLearnedDeadHosts,
      deadHosts: deadImageHosts,
      purge: (hosts) => purgeDeadHostImages(hosts, async (variant, id) => Boolean(await store.find(variant, id)), config.imageHostPurgeLimit)
    }
  });
  if (!result) return [];
  console.log('[worker] image host check probed=' + result.probed + ' dead=' + (result.dead.join(',') || '-') +
    ' verdicts=' + JSON.stringify(result.verdicts) + ' purged=' + result.changedSlugs.length + ' assetsDeleted=' + result.assetsDeleted);
  return result.changedSlugs;
}

/**
 * One-off repair for artwork whose provider CDN moved: walk the NguonC list
 * pages (they already carry the live image URLs, so no detail fetches) and
 * replace only broken image URLs. Position lives in crawl_checkpoints lane
 * 'image-heal'; delete that row to run it again. Once the walk is complete,
 * rows still broken borrow the image another provider source stored.
 */
async function healImageSources() {
  if (!config.imageHealEnabled || stopping) return [];
  const provider = providers.find((candidate) => candidate.name === 'nguonc');
  if (!provider) return [];

  const changed = [];
  let checkpoint = await getCrawlCheckpoint(provider.name, 'image-heal', 1);
  let pages = 0;
  if (!checkpoint.completed_at) {
    let page = checkpoint.next_page;
    try {
      while (pages < config.imageHealPagesPerRun && !stopping) {
        const list = await provider.list('phim-moi-cap-nhat', page);
        const items = provider.listItems(list.data);
        changed.push(...await healImageSourcesFromItems(provider.name, items));
        pages += 1;
        const total = totalPages(list.data);
        const completed = !items.length || Boolean(total && page >= total);
        page += 1;
        await saveCrawlCheckpoint(provider.name, 'image-heal', {
          nextPage: page,
          totalPages: total,
          completed
        });
        if (completed) {
          checkpoint = { completed_at: new Date() };
          break;
        }
      }
    } catch (error) {
      await recordCrawlCheckpointFailure(provider.name, 'image-heal', error).catch(() => {});
      console.warn('[worker] image heal page ' + page + ' failed', error.message);
    }
  }

  let alternate = 0;
  if (checkpoint.completed_at && !stopping) {
    const healed = await healImageSourcesFromAlternate();
    alternate = healed.length;
    changed.push(...healed);
  }
  if (pages || alternate) {
    console.log('[worker] image heal pages=' + pages + ' changed=' + changed.length + ' fromAlternate=' + alternate);
  }
  return [...new Set(changed)];
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
 * Give rows with no tmdb_id and no imdb_id a guessed TMDB id, so the MDBList
 * passes have something to look a rating up by.
 *
 * Writes only `tmdb_lookup_id`, never `tmdb_id`: the same unambiguous
 * exact-title rule as the artwork fallback still lets a wrong title through
 * occasionally, and that must cost one row a wrong score rather than merge two
 * unrelated titles. Returns nothing, because no visitor-visible field changed —
 * the score arrives later, on the MDBList pass, which does its own invalidation.
 */
async function refreshTmdbLookups() {
  if (!config.tmdbEnabled || !config.tmdbLookupEnabled || !config.tmdbApiKey) return;
  const candidates = await listTmdbLookupCandidates();
  if (!candidates.length) return;

  const counts = { matched: 0, unmatched: 0, ambiguous: 0, error: 0 };
  await mapLimit(candidates, config.tmdbLookupConcurrency, async (movie) => {
    try {
      const { tmdbId, status } = await searchTmdbIdByTitle({
        title: movie.original_title,
        mediaType: movie.media_type,
        year: movie.year
      });
      const settled = status === 'matched' && tmdbId ? 'matched' : status;
      counts[settled] = (counts[settled] || 0) + 1;
      await recordTmdbLookup(movie.id, settled, tmdbId);
    } catch (error) {
      counts.error += 1;
      await recordTmdbLookup(movie.id, 'error').catch(() => {});
    }
  });

  console.log('[worker] tmdb lookup checked=' + candidates.length +
    ' matched=' + counts.matched + ' unmatched=' + counts.unmatched +
    ' ambiguous=' + counts.ambiguous + ' error=' + counts.error);
}

/**
 * Fetch TMDB recommendation/similar id lists for the detail-page rail.
 *
 * Runs after the lookup pass because that pass is what gives most rows an id
 * to fetch for. Returns nothing: the rail is matched to the catalog at read
 * time and its response carries its own TTL, so nothing here needs purging.
 */
async function refreshTmdbRecommendations() {
  if (!config.tmdbEnabled || !config.tmdbRecommendationsEnabled || !config.tmdbApiKey) return;
  const candidates = await listTmdbRecommendationCandidates();
  if (!candidates.length) return;

  const counts = { ok: 0, empty: 0, not_found: 0, error: 0 };
  await mapLimit(candidates, config.tmdbRecommendationsConcurrency, async (candidate) => {
    const mediaType = candidate.media_type;
    const tmdbId = Number(candidate.tmdb_id);
    try {
      const lists = await fetchTmdbRecommendations({ mediaType, tmdbId });
      const status = lists.recommended.length || lists.similar.length ? 'ok' : 'empty';
      counts[status] += 1;
      await recordTmdbRecommendations(mediaType, tmdbId, status, lists);
    } catch (error) {
      const status = error.status === 404 ? 'not_found' : 'error';
      counts[status] += 1;
      await recordTmdbRecommendations(mediaType, tmdbId, status, null, error.message).catch(() => {});
    }
  });

  console.log('[worker] tmdb recommendations checked=' + candidates.length +
    ' ok=' + counts.ok + ' empty=' + counts.empty +
    ' not_found=' + counts.not_found + ' error=' + counts.error);
}

/**
 * Cast-verify a TMDB identity for rows the provider gave no tmdb_id.
 *
 * Writes tmdb_match_* only, never tmdb_id (see migration 019). On a verified
 * match the credits the matcher already fetched are stored right away so the
 * cast strip needs no second TMDB call; if that write fails the credits pass
 * picks the identity up later. Returns slugs of newly verified rows, whose
 * detail payload just gained a cast strip.
 */
async function refreshTmdbMatches() {
  if (!config.tmdbEnabled || !config.tmdbMatchEnabled || !config.tmdbApiKey) return [];
  const candidates = await listTmdbMatchCandidates();
  if (!candidates.length) return [];

  const counts = { verified: 0, none: 0, unverifiable: 0, error: 0 };
  const changed = [];
  await mapLimit(candidates, config.tmdbMatchConcurrency, async (movie) => {
    try {
      const verdict = await findCastVerifiedMatch({
        original_title: movie.original_title,
        media_type: movie.media_type,
        year: movie.year,
        actors: movie.actors
      });
      counts[verdict.status] += 1;
      const row = await recordTmdbMatch(movie.id, verdict);
      if (verdict.status === 'verified' && verdict.match) {
        if (verdict.credits) {
          const { mediaType, tmdbId } = verdict.match;
          const status = verdict.credits.cast.length || verdict.credits.directors.length ? 'ok' : 'empty';
          await recordTmdbCredits(mediaType, tmdbId, { ...verdict.credits, status }).catch((error) => {
            console.warn('[worker] tmdb match credits write failed for ' + movie.canonical_slug, error.message);
          });
        }
        if (row?.canonical_slug) changed.push(row.canonical_slug);
      }
    } catch (error) {
      counts.error += 1;
      console.warn('[worker] TMDB match failed for ' + movie.canonical_slug, error.message);
      await recordTmdbMatchFailure(movie.id, error.message).catch(() => {});
    }
  });

  console.log('[worker] tmdb match checked=' + candidates.length +
    ' verified=' + counts.verified + ' none=' + counts.none +
    ' unverifiable=' + counts.unverifiable + ' error=' + counts.error);
  return changed;
}

/**
 * Fetch TMDB cast/director credits for the detail-page cast strip and the
 * person pages.
 *
 * Runs after the recommendations pass and uses the same shape. Returns nothing:
 * the person pages join credits to the catalog at read time and carry their own
 * TTL, and the detail payload picks the strip up on its existing movie:<slug>
 * expiry — so nothing here needs purging. That also keeps the first backfill,
 * which touches tens of thousands of people, from firing thousands of
 * revalidation batches at the frontend.
 */
async function refreshTmdbCredits() {
  if (!config.tmdbEnabled || !config.tmdbCreditsEnabled || !config.tmdbApiKey) return;
  const candidates = await listTmdbCreditCandidates();
  if (!candidates.length) return;

  const counts = { ok: 0, empty: 0, not_found: 0, error: 0 };
  await mapLimit(candidates, config.tmdbCreditsConcurrency, async (candidate) => {
    const mediaType = candidate.media_type;
    const tmdbId = Number(candidate.tmdb_id);
    try {
      const credits = await fetchTmdbCredits({ mediaType, tmdbId });
      const status = credits.cast.length || credits.directors.length ? 'ok' : 'empty';
      counts[status] += 1;
      await recordTmdbCredits(mediaType, tmdbId, { ...credits, status });
    } catch (error) {
      const status = error.status === 404 ? 'not_found' : 'error';
      counts[status] += 1;
      await recordTmdbCreditsFailure(mediaType, tmdbId, status, error.message).catch(() => {});
    }
  });

  console.log('[worker] tmdb credits checked=' + candidates.length +
    ' ok=' + counts.ok + ' empty=' + counts.empty +
    ' not_found=' + counts.not_found + ' error=' + counts.error);
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

/**
 * Fold NguonC-only rows into the KKPhim row of the same work, at most
 * `mergeBatchLimit` per cycle. Runs inside the sync cycle, before invalidation,
 * so the returned slugs (survivor and dropped alias) are flushed with the rest.
 */
let mergeStalledCycles = 0;

async function reconcileDuplicates() {
  const mode = config.mergeDuplicatesMode;
  if (mode === 'off' || stopping) return [];
  const startedAt = Date.now();
  const { pairs, ambiguous } = await planCatalogMerges();
  const evidence = {};
  for (const pair of pairs) evidence[pair.evidence] = (evidence[pair.evidence] || 0) + 1;
  const evidenceText = Object.entries(evidence).map(([name, count]) => name + ':' + count).join(',') || 'none';
  const planMs = Date.now() - startedAt;
  if (mode === 'dry-run') {
    const sample = pairs.slice(0, 5).map((pair) => pair.drop.canonical_slug + '->' + pair.keep.canonical_slug).join(' ');
    console.log('[worker] duplicate merge dry-run pairs=' + pairs.length + ' ambiguous=' + ambiguous.length + ' evidence=' + evidenceText + ' planMs=' + planMs + ' sample=' + sample);
    return [];
  }
  const slugs = [];
  let merged = 0;
  let skipped = 0;
  for (const pair of pairs.slice(0, config.mergeBatchLimit)) {
    if (stopping) break;
    const label = pair.drop.canonical_slug + ' => ' + pair.keep.canonical_slug +
      ' evidence=' + pair.evidence + (pair.renameTo ? ' rename=' + pair.renameTo : '');
    try {
      const result = await mergeDuplicate(pair.keep.id, pair.drop.id, pair.renameTo);
      if (result.merged) {
        merged += 1;
        slugs.push(result.keptSlug, result.droppedSlug, result.previousSlug);
        console.log('[worker] duplicate merge ok ' + label);
      } else {
        skipped += 1;
        console.warn('[worker] duplicate merge skipped ' + label + ' reason=' + result.reason);
      }
    } catch (error) {
      skipped += 1;
      console.warn('[worker] duplicate merge failed ' + label + ': ' + error.message);
    }
  }
  const remaining = Math.max(0, pairs.length - merged);
  mergeStalledCycles = remaining > 0 && merged === 0 ? mergeStalledCycles + 1 : 0;
  console.log('[worker] duplicate merge merged=' + merged + ' skipped=' + skipped + ' remaining=' + remaining +
    ' ambiguous=' + ambiguous.length + ' evidence=' + evidenceText + ' durationMs=' + (Date.now() - startedAt));
  const alerts = mergeAlerts({
    remaining, skipped, ambiguous: ambiguous.length, stalledCycles: mergeStalledCycles, pendingThreshold: config.mergeAlertPending
  });
  for (const alert of alerts) console.warn('[worker] ALERT duplicate merge ' + alert);
  return slugs;
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

  const staleSlugs = await refreshStaleSourcesPass().catch((error) => {
    console.warn('[worker] stale source pass failed', error.message);
    return [];
  });

  const healedImageSlugs = await healImageSources().catch((error) => {
    console.warn('[worker] image heal pass failed', error.message);
    return [];
  });
  const purgedImageSlugs = await checkImageHosts().catch((error) => {
    console.warn('[worker] image host check failed', error.message);
    return [];
  });
  const tmdbImageSlugs = await refreshTmdbImages();
  const tmdbFallbackSlugs = await refreshTmdbImageFallbacks().catch((error) => {
    console.warn('[worker] tmdb image fallback pass failed', error.message);
    return [];
  });
  const mergedSlugs = await reconcileDuplicates().catch((error) => {
    console.warn('[worker] duplicate merge pass failed', error.message);
    return [];
  });
  const changedSlugs = [...new Set([
    ...mergedSlugs,
    ...staleSlugs,
    ...headResults.flatMap((result) => result.changedSlugs),
    ...backfillResults.flatMap((result) => result.changedSlugs),
    ...healedImageSlugs,
    ...purgedImageSlugs,
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
  if (!stopping) await refreshTmdbLookups();
  if (!stopping) {
    await refreshTmdbRecommendations().catch((error) => {
      console.warn('[worker] tmdb recommendations pass failed', error.message);
    });
  }
  if (!stopping) {
    await refreshTmdbCredits().catch((error) => {
      console.warn('[worker] tmdb credits pass failed', error.message);
    });
  }
  if (!stopping) {
    ratingChangedSlugs.push(...await syncTmdbReviews().catch((error) => {
      console.warn('[worker] tmdb reviews pass failed', error.message);
      return [];
    }));
  }
  if (!stopping) {
    ratingChangedSlugs.push(...await syncReviewTranslations().catch((error) => {
      console.warn('[worker] review translate pass failed', error.message);
      return [];
    }));
  }
  if (!stopping) {
    ratingChangedSlugs.push(...await refreshTmdbMatches().catch((error) => {
      console.warn('[worker] tmdb match pass failed', error.message);
      return [];
    }));
  }
  // With the loop on, its own wake-ups spend the Gemini quota; the two never run the same pass.
  if (!stopping && !aiLoopEnabled(config)) {
    ratingChangedSlugs.push(...await refreshTmdbAiMatches().catch((error) => {
      console.warn('[worker] tmdb ai match pass failed', error.message);
      return [];
    }));
  }
  // Dry-run is the report script's job: it cannot page, so every cycle would replay the same batch.
  if (!stopping && config.tmdbIdentityMode === 'apply') {
    const promoted = await promoteVerifiedMatches().catch((error) => {
      console.warn('[worker] tmdb identity promotion failed', error.message);
      return null;
    });
    if (promoted?.checked) {
      console.log('[worker] tmdb identity promote checked=' + promoted.checked + ' assigned=' + promoted.assigned +
        ' merged=' + promoted.merged + ' blocked=' + promoted.blocked + ' conflict=' + promoted.conflict);
      ratingChangedSlugs.push(...promoted.slugs);
    }
  }
  if (!stopping && config.tmdbMatchEnabled) {
    const corrected = await correctGuessedLookupIds().catch((error) => {
      console.warn('[worker] tmdb lookup correction failed', error.message);
      return [];
    });
    if (corrected.length) console.log('[worker] tmdb lookup corrected=' + corrected.length);
    ratingChangedSlugs.push(...corrected);
  }
  if (!stopping) ratingChangedSlugs.push(...await refreshMdblistBackfill());
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
  for (const movieSlug of changedSlugs) keys.push('recommendations:' + movieSlug);
  // Drop the review pages clients actually request (limit 5 from the UI, 10 as the API default);
  // deeper pages simply expire on their 60s TTL.
  for (const movieSlug of changedSlugs) keys.push(...reviewsInvalidationKeys(movieSlug));
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

/**
 * Walk the whole catalog for MDBList scores, one budget-limited slice per run,
 * resuming from a persisted id cursor. The walk wraps rather than retiring, so
 * rows that only became eligible after the cursor passed them still get picked
 * up; a lap with nothing due costs one query and no API call.
 * MDBLIST_BACKFILL_RESET=true forces it back to the start once per process.
 */
async function refreshMdblistBackfill() {
  if (!config.mdblistBackfillEnabled || !config.mdblistApiKeys.length) return [];
  if (Date.now() - lastMdblistBackfillRunAt < config.mdblistBackfillIntervalMs) return [];
  lastMdblistBackfillRunAt = Date.now();

  if (config.mdblistBackfillReset && !mdblistBackfillResetDone) {
    await saveMdblistBackfillCursor({ reset: true }).catch(() => {});
    mdblistBackfillResetDone = true;
    console.log('[worker] mdblist backfill checkpoint reset');
  }

  let checkpoint;
  try {
    checkpoint = await getMdblistBackfillCursor();
  } catch (error) {
    console.warn('[worker] mdblist backfill checkpoint unavailable', error.message);
    return [];
  }
  let stats;
  try {
    stats = await backfillMdblistRatings({ cursor: checkpoint.cursor });
  } catch (error) {
    console.error('[worker] mdblist backfill pass failed', error);
    return [];
  }

  if (stats.cursor) {
    await saveMdblistBackfillCursor({
      cursor: stats.cursor.next
    }).catch((error) => console.warn('[worker] mdblist backfill cursor save failed', error.message));
  }

  stats.overdue = await countMdblistOverdue().catch(() => undefined);
  const line = '[worker] mdblist backfill ' + formatMdblistStats(stats);
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

let aiLoop = null;
function startTmdbMatchAiLoop() {
  if (aiLoop || !aiLoopEnabled(config)) return;
  aiLoop = runTmdbMatchAiLoop({
    signal: stopController.signal,
    onChanged: (slugs) => invalidateForSlugs(slugs)
  }).catch((error) => console.error('[worker] tmdb ai match loop stopped unexpectedly', error));
}

try {
  await runWorkerLoop({
    // The loop needs the migrated schema (gemini_quota_ledger); it is started once, after the first successful migrate.
    initialize: async () => { await migrate(); startTmdbMatchAiLoop(); },
    runCycle: async () => {
      await refreshHeroTrendingIfDue();
      if (!stopping) await syncCycle();
    },
    writeHeartbeat: writeWorkerHeartbeat,
    intervalMs: config.syncIntervalMs,
    // A cycle that outlives the heartbeat TTL is already reported as a dead
    // worker by /api/health, so treat it as one: exit and let Compose restart.
    cycleTimeoutMs: config.workerHeartbeatTtlSeconds * 1000,
    signal: stopController.signal
  });
} catch (error) {
  console.error('[worker] fatal worker failure', error);
  process.exitCode = 1;
} finally {
  // A timed-out cycle can still hold a pooled client or a wedged Valkey socket,
  // which would stall a graceful close forever. Bound it, then exit.
  // The loop stops after its current request (the signal aborts an in-flight Gemini call); bound the wait.
  if (aiLoop) await Promise.race([aiLoop, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  await Promise.race([
    Promise.allSettled([closeCache(), closeDatabase()]),
    new Promise((resolve) => setTimeout(resolve, 5000).unref())
  ]);
  process.exit();
}
