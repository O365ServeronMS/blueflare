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

/** Key list from a comma string (or array): trimmed, empties dropped, deduped, order kept. */
export function parseApiKeys(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

// Free-tier rotation, best first. Translation uses the flash-lite family only (500 RPD per key);
// the 20-RPD flash models are left to the TMDB match pass. Ids verified against ai.google.dev.
const DEFAULT_GEMINI_MODELS = [
  'gemini-3.5-flash-lite:15', 'gemini-3.1-flash-lite:15'
].join(',');
const DEFAULT_TMDB_MATCH_GEMINI_MODELS = 'gemini-3.8-flash:5,gemini-3.7-flash:5,gemini-3.6-flash:5';
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
  heroTrendingMaxCandidatePages: integer('HERO_TRENDING_MAX_CANDIDATE_PAGES', 8, 1),
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
  // Guesses a TMDB id from the title for rows with no tmdb_id and no imdb_id,
  // purely as an MDBList lookup key. TMDB has no hard daily cap, so this can run
  // far wider than the image fallback beside it.
  tmdbLookupEnabled: boolean('TMDB_LOOKUP_ENABLED', true),
  tmdbLookupLimit: integer('TMDB_LOOKUP_LIMIT', 500, 1),
  tmdbLookupConcurrency: integer('TMDB_LOOKUP_CONCURRENCY', 4, 1),
  tmdbLookupRetryMs: integer('TMDB_LOOKUP_RETRY_MS', 30 * 24 * 60 * 60 * 1000, 60 * 1000),

  // TMDB recommendation/similar id lists for the detail-page rail. Keyed by
  // TMDB identity, refreshed slowly: the lists barely move week to week.
  tmdbRecommendationsEnabled: boolean('TMDB_RECOMMENDATIONS_ENABLED', true),
  tmdbRecommendationsLimit: integer('TMDB_RECOMMENDATIONS_LIMIT', 300, 1),
  tmdbRecommendationsConcurrency: integer('TMDB_RECOMMENDATIONS_CONCURRENCY', 3, 1),
  tmdbRecommendationsRefreshMs: integer('TMDB_RECOMMENDATIONS_REFRESH_MS', 14 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  tmdbRecommendationsRetryMs: integer('TMDB_RECOMMENDATIONS_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),

  // TMDB cast/director credits, keyed by TMDB identity. Verified ids only:
  // a wrong guess here prints the wrong actor on a movie page.
  tmdbCreditsEnabled: boolean('TMDB_CREDITS_ENABLED', true),
  tmdbCreditsLimit: integer('TMDB_CREDITS_LIMIT', 300, 1),
  tmdbCreditsConcurrency: integer('TMDB_CREDITS_CONCURRENCY', 3, 1),
  tmdbCreditsCastLimit: integer('TMDB_CREDITS_CAST_LIMIT', 12, 1),
  tmdbCreditsRefreshMs: integer('TMDB_CREDITS_REFRESH_MS', 90 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  tmdbCreditsRetryMs: integer('TMDB_CREDITS_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),

  // TMDB user reviews for the detail page, per catalog row with a verified TMDB
  // identity. Plain text only; spoiler flag and score are computed at write time.
  tmdbReviewsEnabled: boolean('TMDB_REVIEWS_ENABLED', true),
  tmdbReviewsLimit: integer('TMDB_REVIEWS_LIMIT', 200, 1),
  tmdbReviewsConcurrency: integer('TMDB_REVIEWS_CONCURRENCY', 3, 1),
  tmdbReviewsRefreshMs: integer('TMDB_REVIEWS_REFRESH_MS', 7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  tmdbReviewsRetryMs: integer('TMDB_REVIEWS_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
  tmdbReviewsMaxPerMovie: integer('TMDB_REVIEWS_MAX_PER_MOVIE', 40, 1),
  // English -> Vietnamese machine translation of stored reviews (worker only).
  translateEnabled: boolean('TRANSLATE_ENABLED', true),
  translateProvider: String(process.env.TRANSLATE_PROVIDER || 'gemini'),
  translateReviewsPerCycle: integer('TRANSLATE_REVIEWS_PER_CYCLE', 150, 1),
  translateDelayMs: integer('TRANSLATE_DELAY_MS', 1000, 0),
  translateMaxConsecutiveErrors: integer('TRANSLATE_MAX_CONSECUTIVE_ERRORS', 5, 1),
  translateCooldownMs: integer('TRANSLATE_COOLDOWN_MS', 60 * 60 * 1000, 1000),
  translateTimeoutMs: integer('TRANSLATE_TIMEOUT_MS', 10000, 1000),
  // Deduped key list from GEMINI_API_KEYS. Quota is per Google project, so keys should come from different projects.
  geminiApiKeys: parseApiKeys(process.env.GEMINI_API_KEYS),
  // Ordered `id[:rpm]` list. GEMINI_MODEL (single id) only applies when GEMINI_MODELS is empty.
  geminiModels: String(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODELS).trim(),
  geminiTimeoutMs: integer('GEMINI_TIMEOUT_MS', 30000, 1000),
  geminiDelayMs: integer('GEMINI_DELAY_MS', 0, 0),
  geminiCooldownMs: integer('GEMINI_COOLDOWN_MS', 6 * 60 * 60 * 1000, 1000),
  // Score 0-100 = rating*10 (neutral 50 when unrated), length and recency parts.
  reviewScore: Object.freeze({
    ratingWeight: 0.6,
    lengthWeight: 0.25,
    recencyWeight: 0.15,
    lengthCap: 1500,
    monthlyDecay: 0.95,
    neutralRating: 50
  }),

  // Cast-verified TMDB identity for rows the provider gave no tmdb_id. Stored in
  // tmdb_match_*, never in tmdb_id. Off by default: it costs ~7 TMDB calls per row.
  // NguonC-only rows folded into the KKPhim row of the same work: off | dry-run | apply.
  mergeDuplicatesMode: ['off', 'dry-run', 'apply'].includes(process.env.MERGE_DUPLICATES_MODE)
    ? process.env.MERGE_DUPLICATES_MODE
    : 'off',
  mergeAlertPending: integer('MERGE_ALERT_PENDING', 200, 1),
  mergeBatchLimit: integer('MERGE_BATCH_LIMIT', 50, 1),
  // TMDB identity promotion: cast-verified tmdb_match_* rows become real tmdb_id (source 'inferred'),
  // folding into the row that already holds the identity. off | dry-run | apply.
  tmdbIdentityMode: ['off', 'dry-run', 'apply'].includes(process.env.TMDB_IDENTITY_MODE)
    ? process.env.TMDB_IDENTITY_MODE
    : 'off',
  tmdbIdentityPromoteBatch: integer('TMDB_IDENTITY_PROMOTE_BATCH', 200, 1),
  tmdbMatchEnabled: boolean('TMDB_MATCH_ENABLED', false),
  tmdbMatchLimit: integer('TMDB_MATCH_LIMIT', 60, 1),
  tmdbMatchConcurrency: integer('TMDB_MATCH_CONCURRENCY', 2, 1),
  tmdbMatchRefreshMs: integer('TMDB_MATCH_REFRESH_MS', 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  tmdbMatchRetryMs: integer('TMDB_MATCH_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
  // Primary-country slugs left unmatched on purpose (cast names do not transliterate).
  tmdbMatchSkipCountries: csv('TMDB_MATCH_SKIP_COUNTRIES', 'trung-quoc,hong-kong,nhat-ban,han-quoc,thai-lan'),
  // AI candidate ranking for TMDB matching. Own keys/models on purpose: never falls back to GEMINI_API_KEYS.
  tmdbMatchAiEnabled: boolean('TMDB_MATCH_AI_ENABLED', false),
  tmdbMatchGeminiApiKeys: parseApiKeys(process.env.TMDB_MATCH_GEMINI_API_KEYS),
  tmdbMatchGeminiModels: String(process.env.TMDB_MATCH_GEMINI_MODELS || DEFAULT_TMDB_MATCH_GEMINI_MODELS).trim(),
  // Films are packed into one request until either limit. TMDB_MATCH_GEMINI_BATCH is the deprecated name of BATCH_MAX.
  tmdbMatchGeminiBatchTokens: integer('TMDB_MATCH_GEMINI_BATCH_TOKENS', 40000, 1000),
  tmdbMatchGeminiBatchMax: integer('TMDB_MATCH_GEMINI_BATCH_MAX', integer('TMDB_MATCH_GEMINI_BATCH', 40, 1), 1),
  tmdbMatchGeminiTimeoutMs: integer('TMDB_MATCH_GEMINI_TIMEOUT_MS', 180000, 1000),
  // Free-tier limits per key+model. RPD is the binding one; a model entry may override it as id:rpm:rpd.
  tmdbMatchGeminiRpd: integer('TMDB_MATCH_GEMINI_RPD', 20, 1),
  tmdbMatchGeminiTpm: integer('TMDB_MATCH_GEMINI_TPM', 250000, 1000),
  // Thinking tokens per request: batches of rows with a cast (tier 1) and without (tier 2, name+year only). 0 = not sent.
  tmdbMatchGeminiThinkT1: integer('TMDB_MATCH_GEMINI_THINK_T1', 0, 0),
  tmdbMatchGeminiThinkT2: integer('TMDB_MATCH_GEMINI_THINK_T2', 4096, 0),
  tmdbMatchGeminiCooldownMs: integer('TMDB_MATCH_GEMINI_COOLDOWN_MS', 6 * 60 * 60 * 1000, 1000),
  tmdbMatchGeminiTransientParkMs: integer('TMDB_MATCH_GEMINI_TRANSIENT_PARK_MS', 45000, 1000),
  tmdbMatchGeminiTransientParkMaxMs: integer('TMDB_MATCH_GEMINI_TRANSIENT_PARK_MAX_MS', 5 * 60 * 1000, 1000),
  // Worker pass that applies the ranking: off | dry-run (audit rows only) | apply (assigns tmdb_id).
  tmdbMatchAiMode: ['off', 'dry-run', 'apply'].includes(process.env.TMDB_MATCH_AI_MODE) ? process.env.TMDB_MATCH_AI_MODE : 'dry-run',
  tmdbMatchAiLimit: integer('TMDB_MATCH_AI_LIMIT', 100, 1),
  tmdbMatchAiRetryMs: integer('TMDB_MATCH_AI_RETRY_MS', 14 * 24 * 60 * 60 * 1000, 60 * 1000),
  tmdbMatchAiErrorRetryMs: integer('TMDB_MATCH_AI_ERROR_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
  // Own background loop (tmdbMatchAiLoop.js) spends the daily quota; false puts the pass back into the sync cycle.
  tmdbMatchAiLoop: boolean('TMDB_MATCH_AI_LOOP', true),
  tmdbMatchAiLoopMs: integer('TMDB_MATCH_AI_LOOP_MS', 60 * 1000, 5000),
  // Share of the daily requests kept for new films and retries; the old backlog may not touch it.
  tmdbMatchAiReservePct: Math.min(90, integer('TMDB_MATCH_AI_RESERVE_PCT', 10, 0)),
  // A film is "new" for the reserve this long after it was first seen.
  tmdbMatchAiFreshMs: integer('TMDB_MATCH_AI_FRESH_MS', 3 * 24 * 60 * 60 * 1000, 60 * 1000),

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
  // Matched rows refresh by title age (catalog_sort_at): new < 90 days, mid < 2 years, old beyond.
  mdblistRefreshNewMs: integer('MDBLIST_REFRESH_NEW_MS', 7 * 24 * 60 * 60 * 1000, 60 * 1000),
  mdblistRefreshMs: integer('MDBLIST_REFRESH_MS', 14 * 24 * 60 * 60 * 1000, 60 * 1000),
  mdblistRefreshOldMs: integer('MDBLIST_REFRESH_OLD_MS', 45 * 24 * 60 * 60 * 1000, 60 * 1000),
  mdblistMissRetryMs: integer('MDBLIST_MISS_RETRY_MS', 90 * 24 * 60 * 60 * 1000, 60 * 1000),
  mdblistErrorRetryMs: integer('MDBLIST_ERROR_RETRY_MS', 60 * 60 * 1000, 60 * 1000),
  // Full-catalog backfill: walks the movies table by id cursor to reach rows the
  // demand-driven pass never sees. On by default; reset re-walks from the start.
  mdblistBackfillEnabled: boolean('MDBLIST_BACKFILL_ENABLED', true),
  mdblistBackfillBatchLimit: integer('MDBLIST_BACKFILL_BATCH_LIMIT', 300, 1),
  // Must stay below SYNC_INTERVAL_MS. The pass runs a few seconds into each
  // cycle, after the demand-driven pass, so an interval equal to the cycle
  // period makes consecutive runs land ~893s apart and silently skip a cycle.
  mdblistBackfillIntervalMs: integer('MDBLIST_BACKFILL_INTERVAL_MS', Math.floor(syncIntervalMs / 2), 60 * 1000),
  mdblistBackfillReset: boolean('MDBLIST_BACKFILL_RESET', false),

  redisUrl: process.env.REDIS_URL || 'redis://valkey:6379',
  imageSigningSecret,
  imageCacheDir: process.env.IMAGE_CACHE_DIR || '/data/images',
  imageAllowedHosts: csv('IMAGE_ALLOWED_HOSTS', 'phim.nguonc.com,img.nguonc.com,phimimg.com,phimapi.com,image.tmdb.org'),
  // Host ảnh gốc đã ngừng phục vụ: URL trỏ vào đây coi như mất, được thay khi có nguồn khác.
  imageDeadHosts: csv('IMAGE_DEAD_HOSTS', 'phim.nguonc.com'),
  imageHealEnabled: boolean('IMAGE_HEAL_ENABLED', true),
  imageHealPagesPerRun: integer('IMAGE_HEAL_PAGES_PER_RUN', 300, 1),
  // Kiểm tra sống/chết của từng host trong allowlist mỗi ngày; host chết liên tiếp
  // IMAGE_HOST_DEAD_AFTER_CHECKS lần thì bị loại khỏi allowlist hiệu lực và link của nó bị dọn.
  imageHostCheckEnabled: boolean('IMAGE_HOST_CHECK_ENABLED', true),
  imageHostCheckIntervalMs: integer('IMAGE_HOST_CHECK_INTERVAL_MS', 24 * 60 * 60 * 1000, 60 * 1000),
  imageHostCheckSamples: integer('IMAGE_HOST_CHECK_SAMPLES', 8, 1),
  imageHostDeadAfterChecks: integer('IMAGE_HOST_DEAD_AFTER_CHECKS', 3, 1),
  imageHostPurgeLimit: integer('IMAGE_HOST_PURGE_LIMIT', 5000, 1),
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
  // A finished backfill walk restarts after this many days so list pages keep
  // refreshing last_seen_at / catching changed rows. 0 disables.
  sweepCycleDays: integer('SWEEP_CYCLE_DAYS', 14, 0),
  // Stale-source refresh lane: re-fetch detail for sources not upserted for
  // staleSourceDays. Marking unavailable needs mode=apply and two 404s >= 7 days apart.
  staleSourceMode: ['off', 'dry-run', 'apply'].includes(process.env.STALE_SOURCE_MODE)
    ? process.env.STALE_SOURCE_MODE
    : 'dry-run',
  staleSourceDays: integer('STALE_SOURCE_DAYS', 14, 1),
  staleSourceBatch: integer('STALE_SOURCE_BATCH', 150, 1),
  requestTimeoutMs: integer('REQUEST_TIMEOUT_MS', 15000, 1000),
  nguoncRequestMinIntervalMs: integer('NGUONC_REQUEST_MIN_INTERVAL_MS', 0),
  kkphimRequestMinIntervalMs: integer('KKPHIM_REQUEST_MIN_INTERVAL_MS', 1000),
  responseCacheTtlSeconds: integer('RESPONSE_CACHE_TTL_SECONDS', 300, 1),
  responseCacheStaleSeconds: integer('RESPONSE_CACHE_STALE_SECONDS', 86400, 1),
  cdnTtlSeconds: integer('CDN_TTL_SECONDS', 300, 1),
  allowedOrigins: csv('ALLOWED_ORIGINS', 'https://phim.bluesia.net'),
  // Cache/tag invalidation fan-out after a sync cycle changes canonical rows.
  invalidateListTypes: csv('INVALIDATE_LIST_TYPES', 'phim-moi-cap-nhat,phim-le,phim-bo,hoat-hinh,tv-shows'),
  invalidatePageDepth: integer('INVALIDATE_PAGE_DEPTH', 3, 1),
  revalidateTimeoutMs: integer('REVALIDATE_TIMEOUT_MS', 5000, 100),
  frontendRevalidateUrl: String(process.env.FRONTEND_REVALIDATE_URL || 'http://frontend:3000/api/internal/revalidate'),
  frontendRevalidateSecret: String(process.env.FRONTEND_REVALIDATE_SECRET || ''),
  metricsToken: String(process.env.METRICS_TOKEN || '')
});
