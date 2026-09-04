function integer(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

function csv(name, fallback = '') {
  return String(process.env[name] || fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const nodeEnv = process.env.NODE_ENV || 'development';
const syncIntervalMs = integer('SYNC_INTERVAL_MS', 15 * 60 * 1000, 1000);
const imageSigningSecret = process.env.IMAGE_SIGNING_SECRET || (
  nodeEnv === 'production' ? '' : 'blueflare-local-development-signing-secret'
);

if (nodeEnv === 'production' && imageSigningSecret.length < 32) {
  throw new Error('IMAGE_SIGNING_SECRET must contain at least 32 characters in production');
}

export const config = Object.freeze({
  nodeEnv,
  port: integer('PORT', 3200, 1),
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || 'https://img.bluesia.net').replace(/\/$/, ''),
  tmdbApiKey: String(process.env.TMDB_API_KEY || ''),
  tmdbBaseUrl: String(process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/$/, ''),
  tmdbTrendingLanguage: String(process.env.TMDB_TRENDING_LANGUAGE || 'vi-VN'),
  tmdbImageBaseUrl: String(process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p').replace(/\/$/, ''),
  // Ceiling is a data-shape constant (hero snapshot table), not a tunable -
  // keep the floor at 1 so the env value actually takes effect below 24.
  heroTrendingLimit: Math.min(24, integer('HERO_TRENDING_LIMIT', 24, 1)),
  heroTrendingCandidatePages: integer('HERO_TRENDING_CANDIDATE_PAGES', 3, 1),
  heroTrendingRefreshMs: integer('HERO_TRENDING_REFRESH_MS', 60 * 60 * 1000, 60 * 1000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://blueflare:blueflare@postgres:5432/blueflare',
  // Master switch for all TMDB calls (trending hero + image sync + image fallback).
  // Also gated in practice by tmdbApiKey being non-empty.
  tmdbEnabled: boolean('TMDB_ENABLED', true),
  tmdbRequestTimeoutMs: integer('TMDB_REQUEST_TIMEOUT_MS', 5000, 1000),
  tmdbImageSyncEnabled: boolean('TMDB_IMAGE_SYNC_ENABLED', true),
  tmdbImageSyncLimit: integer('TMDB_IMAGE_SYNC_LIMIT', 32, 1),
  tmdbImageSyncConcurrency: integer('TMDB_IMAGE_SYNC_CONCURRENCY', 2, 1),
  tmdbImageRetryMs: integer('TMDB_IMAGE_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
  // Title-search fallback for rows with no provider artwork. Kept small per run
  // and retried slowly: a miss usually means TMDB has no such title at all.
  tmdbImageFallbackEnabled: boolean('TMDB_IMAGE_FALLBACK_ENABLED', true),
  tmdbImageFallbackLimit: integer('TMDB_IMAGE_FALLBACK_LIMIT', 16, 1),
  tmdbImageFallbackConcurrency: integer('TMDB_IMAGE_FALLBACK_CONCURRENCY', 2, 1),
  tmdbImageFallbackRetryMs: integer('TMDB_IMAGE_FALLBACK_RETRY_MS', 7 * 24 * 60 * 60 * 1000, 60 * 1000),

  // MDBList supplies both Rotten Tomatoes critic and audience percentages shown
  // on cards. Gated by the key list being non-empty, like TMDB above.
  mdblistEnabled: boolean('MDBLIST_ENABLED', false),
  mdblistApiKeys: [...new Set([
    String(process.env.MDBLIST_API_KEY || '').trim(),
    ...csv('MDBLIST_API_KEYS')
  ].filter(Boolean))],
  mdblistBaseUrl: String(process.env.MDBLIST_BASE_URL || 'https://api.mdblist.com').replace(/\/$/, ''),
  mdblistRequestTimeoutMs: integer('MDBLIST_REQUEST_TIMEOUT_MS', 5000, 1000),
  mdblistRatingTypes: csv('MDBLIST_RATING_TYPES', 'trending,phim-le,phim-bo'),
  mdblistPageDepth: integer('MDBLIST_PAGE_DEPTH', 2, 1),
  // Free accounts accept 10 ids in one rating request; supporter accounts can
  // raise this manually as far as the documented maximum of 100.
  mdblistIdsPerRequest: Math.min(100, integer('MDBLIST_IDS_PER_REQUEST', 10, 1)),
  // The API quota is counted per HTTP request and resets at 00:00 UTC.
  mdblistDailyBudget: integer('MDBLIST_DAILY_BUDGET', 1000, 0),
  mdblistBudgetReserve: integer('MDBLIST_BUDGET_RESERVE', 50, 0),
  mdblistBatchLimit: integer('MDBLIST_BATCH_LIMIT', 60, 1),
  mdblistConcurrency: integer('MDBLIST_CONCURRENCY', 2, 1),
  mdblistRefreshMs: integer('MDBLIST_REFRESH_MS', 30 * 24 * 60 * 60 * 1000, 60 * 1000),
  mdblistMissRetryMs: integer('MDBLIST_MISS_RETRY_MS', 90 * 24 * 60 * 60 * 1000, 60 * 1000),
  mdblistErrorRetryMs: integer('MDBLIST_ERROR_RETRY_MS', 60 * 60 * 1000, 60 * 1000),
  // Full-catalog backfill: walks the movies table by id cursor to reach rows the
  // demand-driven pass never sees. On by default; reset re-walks from the start.
  mdblistBackfillEnabled: boolean('MDBLIST_BACKFILL_ENABLED', true),
  mdblistBackfillBatchLimit: integer('MDBLIST_BACKFILL_BATCH_LIMIT', 300, 1),
  mdblistBackfillIntervalMs: integer('MDBLIST_BACKFILL_INTERVAL_MS', syncIntervalMs, 60 * 1000),
  mdblistBackfillReset: boolean('MDBLIST_BACKFILL_RESET', false),

  redisUrl: process.env.REDIS_URL || 'redis://valkey:6379',
  imageSigningSecret,
  imageCacheDir: process.env.IMAGE_CACHE_DIR || '/data/images',
  imageAllowedHosts: csv('IMAGE_ALLOWED_HOSTS', 'phim.nguonc.com,phimimg.com,phimapi.com,image.tmdb.org'),
  // Image prewarming: the worker asks the API to build the cache entries the
  // home/list viewmodels are about to serve, so the first visitor after a sync
  // does not pay the upstream fetch + sharp transcode. Reached over the Docker
  // network; never a public URL.
  imageOriginUrl: String(process.env.IMAGE_ORIGIN_URL || 'http://api:3200').replace(/\/$/, ''),
  imagePrewarmEnabled: boolean('IMAGE_PREWARM_ENABLED', true),
  // 0 warms the home viewmodel only; each extra level adds one page of every
  // INVALIDATE_LIST_TYPES list.
  imagePrewarmPageDepth: integer('IMAGE_PREWARM_PAGE_DEPTH', 1, 0),
  imagePrewarmLimit: integer('IMAGE_PREWARM_LIMIT', 400, 1),
  imagePrewarmConcurrency: integer('IMAGE_PREWARM_CONCURRENCY', 4, 1),
  imagePrewarmTimeoutMs: integer('IMAGE_PREWARM_TIMEOUT_MS', 20000, 1000),
  imagePrewarmRetries: integer('IMAGE_PREWARM_RETRIES', 2, 0),
  imagePrewarmRetryBaseMs: integer('IMAGE_PREWARM_RETRY_BASE_MS', 500, 50),
  // Hard floor on free space; the cache has no evictor, so prewarming stands
  // down rather than being the thing that fills the disk.
  imagePrewarmMinFreeBytes: integer('IMAGE_PREWARM_MIN_FREE_BYTES', 2 * 1024 * 1024 * 1024, 0),

  // Image cache caretaker (api). The cache is disposable and had no ceiling at
  // all; these bound it. Eviction lives in the api because the api is the only
  // process that writes /data/images.
  // 0 disables eviction (the orphan-.tmp pass still runs); 0 interval disables
  // the sweep entirely.
  imageCacheMaxBytes: integer('IMAGE_CACHE_MAX_BYTES', 8 * 1024 * 1024 * 1024, 0),
  imageCacheEvictTargetPercent: Math.min(99, integer('IMAGE_CACHE_EVICT_TARGET_PERCENT', 90, 10)),
  // Never evict something read this recently: it may be streaming right now.
  imageCacheEvictMinAgeMs: integer('IMAGE_CACHE_EVICT_MIN_AGE_MS', 60 * 60 * 1000, 60 * 1000),
  imageCacheTmpMaxAgeMs: integer('IMAGE_CACHE_TMP_MAX_AGE_MS', 60 * 60 * 1000, 60 * 1000),
  imageCacheSweepIntervalMs: integer('IMAGE_CACHE_SWEEP_INTERVAL_MS', 60 * 60 * 1000, 0),
  imageCacheSweepStartDelayMs: integer('IMAGE_CACHE_SWEEP_START_DELAY_MS', 60 * 1000, 1000),
  nguoncBaseUrl: String(process.env.NGUONC_BASE_URL || 'https://phim.nguonc.com').replace(/\/$/, ''),
  kkphimBaseUrl: String(process.env.KKPHIM_BASE_URL || 'https://phimapi.com').replace(/\/$/, ''),
  // Head sync: scans the newest N pages of each provider every cycle.
  syncEnabled: boolean('SYNC_ENABLED', true),
  syncProviders: csv('SYNC_PROVIDERS', 'nguonc,kkphim'),
  syncPagesPerRun: integer('SYNC_PAGES_PER_RUN', 3, 1),
  syncConcurrency: integer('SYNC_CONCURRENCY', 4, 1),
  syncIntervalMs,
  // The worker refreshes this lease at cycle start and completion. Two sync
  // intervals plus a small allowance distinguishes a slow cycle from a dead
  // worker without another hand-tuned deployment knob.
  workerHeartbeatTtlSeconds: Math.max(60, Math.ceil(((syncIntervalMs * 2) + (5 * 60 * 1000)) / 1000)),
  // Backfill: walks older pages behind a persisted checkpoint. Runs on its own
  // cadence (backfillIntervalMs) independent of the head-sync interval above.
  backfillEnabled: boolean('BACKFILL_ENABLED', true),
  backfillProviders: csv('BACKFILL_PROVIDERS', 'nguonc,kkphim'),
  backfillStartPage: integer('BACKFILL_START_PAGE', 0, 0),
  // 0 = no ceiling; backfill runs until the provider reports it has no more pages.
  backfillEndPage: integer('BACKFILL_END_PAGE', 0, 0),
  backfillPagesPerRun: integer('BACKFILL_PAGES_PER_RUN', 1, 1),
  backfillIntervalMs: integer('BACKFILL_INTERVAL_MS', 15 * 60 * 1000, 1000),
  backfillCooldownMs: integer('BACKFILL_COOLDOWN_MS', 0, 0),
  requestTimeoutMs: integer('REQUEST_TIMEOUT_MS', 15000, 1000),
  nguoncRequestMinIntervalMs: integer('NGUONC_REQUEST_MIN_INTERVAL_MS', 0),
  kkphimRequestMinIntervalMs: integer('KKPHIM_REQUEST_MIN_INTERVAL_MS', 1000),
  responseCacheTtlSeconds: integer('RESPONSE_CACHE_TTL_SECONDS', 300, 1),
  responseCacheStaleSeconds: integer('RESPONSE_CACHE_STALE_SECONDS', 86400, 1),
  cdnTtlSeconds: integer('CDN_TTL_SECONDS', 300, 1),
  allowedOrigins: csv(
    'ALLOWED_ORIGINS',
    'https://film.bluesia.net,https://phim.bluesia.net'
  ),
  // Cache/tag invalidation fan-out after a sync cycle changes canonical rows.
  invalidateListTypes: csv('INVALIDATE_LIST_TYPES', 'phim-moi-cap-nhat,phim-le,phim-bo,hoat-hinh,tv-shows'),
  invalidatePageDepth: integer('INVALIDATE_PAGE_DEPTH', 3, 1),
  revalidateTimeoutMs: integer('REVALIDATE_TIMEOUT_MS', 5000, 100),
  frontendRevalidateUrl: String(process.env.FRONTEND_REVALIDATE_URL || 'http://frontend:3000/api/internal/revalidate'),
  frontendRevalidateSecret: String(process.env.FRONTEND_REVALIDATE_SECRET || ''),
  metricsToken: String(process.env.METRICS_TOKEN || '')
});
