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
  heroTrendingLimit: Math.min(24, integer('HERO_TRENDING_LIMIT', 24, 24)),
  heroTrendingCandidatePages: integer('HERO_TRENDING_CANDIDATE_PAGES', 3, 1),
  heroTrendingRefreshMs: integer('HERO_TRENDING_REFRESH_MS', 60 * 60 * 1000, 60 * 1000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://blueflare:blueflare@postgres:5432/blueflare',
  tmdbImageSyncLimit: integer('TMDB_IMAGE_SYNC_LIMIT', 32, 1),
  tmdbImageSyncConcurrency: integer('TMDB_IMAGE_SYNC_CONCURRENCY', 2, 1),
  tmdbImageRetryMs: integer('TMDB_IMAGE_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
  // Title-search fallback for rows with no provider artwork. Kept small per run
  // and retried slowly: a miss usually means TMDB has no such title at all.
  tmdbImageFallbackLimit: integer('TMDB_IMAGE_FALLBACK_LIMIT', 16, 1),
  tmdbImageFallbackConcurrency: integer('TMDB_IMAGE_FALLBACK_CONCURRENCY', 2, 1),
  tmdbImageFallbackRetryMs: integer('TMDB_IMAGE_FALLBACK_RETRY_MS', 7 * 24 * 60 * 60 * 1000, 60 * 1000),
  redisUrl: process.env.REDIS_URL || 'redis://valkey:6379',
  imageSigningSecret,
  imageCacheDir: process.env.IMAGE_CACHE_DIR || '/data/images',
  imageAllowedHosts: csv('IMAGE_ALLOWED_HOSTS', 'phim.nguonc.com,phimimg.com,phimapi.com,image.tmdb.org'),
  nguoncBaseUrl: String(process.env.NGUONC_BASE_URL || 'https://phim.nguonc.com').replace(/\/$/, ''),
  kkphimBaseUrl: String(process.env.KKPHIM_BASE_URL || 'https://phimapi.com').replace(/\/$/, ''),
  syncPagesPerRun: integer('SYNC_PAGES_PER_RUN', 3, 1),
  syncConcurrency: integer('SYNC_CONCURRENCY', 4, 1),
  syncIntervalMs: integer('SYNC_INTERVAL_MS', 15 * 60 * 1000, 1000),
  backfillEnabled: boolean('BACKFILL_ENABLED', true),
  backfillStartPage: integer('BACKFILL_START_PAGE', 0, 0),
  backfillPagesPerRun: integer('BACKFILL_PAGES_PER_RUN', 1, 1),
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
  frontendRevalidateUrl: String(process.env.FRONTEND_REVALIDATE_URL || 'http://frontend:3000/api/internal/revalidate'),
  frontendRevalidateSecret: String(process.env.FRONTEND_REVALIDATE_SECRET || ''),
  metricsToken: String(process.env.METRICS_TOKEN || '')
});
