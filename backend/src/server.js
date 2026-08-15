import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { cacheVersion, closeCache, getOrBuild } from './cache.js';
import { config } from './config.js';
import { closeDatabase, migrate, postgresHealth } from './db.js';
import { serveSignedImage } from './images.js';
import { providerHealth } from './repository.js';
import { metricsSnapshot, observeCache, observeRequest } from './observability.js';
import {
  buildCountry,
  buildGenre,
  buildHome,
  buildList,
  buildMovie,
  buildRecommendations,
  buildSearch,
  buildTaxonomy
} from './viewmodels.js';
import { redisHealth } from './cache.js';

function page(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(1000, Math.floor(parsed));
}

function normalizeKeyPart(value, maxLength = 160) {
  return String(value || '').trim().toLowerCase().slice(0, maxLength);
}

function normalizeKeyword(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function allowedOrigin(origin) {
  if (!origin) return null;
  if (config.allowedOrigins.includes(origin)) return origin;
  try {
    const url = new URL(origin);
    if (
      url.protocol === 'https:' &&
      (url.hostname === 'bluesia.net' || url.hostname.endsWith('.bluesia.net'))
    ) return origin;
    if (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) return origin;
  } catch {
    return null;
  }
  return null;
}

function corsHeaders(request) {
  const origin = allowedOrigin(request.headers.origin);
  return origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Accept, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin'
  } : {};
}

function json(response, request, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...corsHeaders(request),
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(body);
}

async function cachedJson(request, response, key, builder, ttl) {
  const result = await getOrBuild(key, builder, { ttl });
  observeCache(result.cacheStatus);
  json(response, request, 200, result.data, {
    'cache-control': 'public, max-age=60, stale-while-revalidate=' +
      config.responseCacheStaleSeconds + ', stale-if-error=' + config.responseCacheStaleSeconds,
    'x-blueflare-cache': result.cacheStatus
  });
}


function validMetricsToken(request) {
  const expected = Buffer.from(config.metricsToken);
  const actual = Buffer.from(String(request.headers['x-blueflare-metrics'] || ''));
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function healthPayload() {
  const [postgres, valkey, providers, version] = await Promise.all([
    postgresHealth().catch((error) => ({ ok: false, error: error.message })),
    redisHealth().catch((error) => ({ ok: false, error: error.message })),
    providerHealth().catch(() => []),
    cacheVersion()
  ]);
  return {
    status: postgres.ok && valkey.ok ? 'ok' : 'degraded',
    postgres,
    valkey,
    cacheVersion: version,
    providers,
    timestamp: new Date().toISOString()
  };
}

async function route(request, response) {
  const url = new URL(request.url || '/', 'http://blueflare.local');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, request, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname.startsWith('/i/')) {
    const handled = await serveSignedImage(
      request,
      response,
      url.pathname,
      url.searchParams
    );
    if (!handled) json(response, request, 404, { error: 'Image not found' });
    return;
  }

  if (url.pathname === '/api/metrics') {
    if (!config.metricsToken) {
      json(response, request, 404, { error: 'Not found' }, { 'cache-control': 'no-store' });
      return;
    }
    if (!validMetricsToken(request)) {
      json(response, request, 401, { error: 'Unauthorized' }, { 'cache-control': 'no-store' });
      return;
    }
    json(response, request, 200, metricsSnapshot(), { 'cache-control': 'no-store' });
    return;
  }

  if (url.pathname === '/api/health' || url.pathname === '/healthz') {
    const payload = await healthPayload();
    json(response, request, payload.status === 'ok' ? 200 : 503, payload, {
      'cache-control': 'no-store'
    });
    return;
  }

  if (url.pathname === '/api/home-data') {
    await cachedJson(request, response, 'home', buildHome, 300);
    return;
  }

  if (url.pathname === '/api/list') {
    const type = normalizeKeyPart(url.searchParams.get('type') || 'phim-moi-cap-nhat', 80) || 'phim-moi-cap-nhat';
    const currentPage = page(url.searchParams.get('page'));
    await cachedJson(
      request,
      response,
      'list:' + type + ':' + currentPage,
      () => buildList(type, currentPage),
      300
    );
    return;
  }

  if (url.pathname === '/api/genre') {
    const slug = normalizeKeyPart(url.searchParams.get('slug'), 120);
    const currentPage = page(url.searchParams.get('page'));
    await cachedJson(
      request,
      response,
      'genre:' + slug + ':' + currentPage,
      () => buildGenre(slug, currentPage),
      300
    );
    return;
  }

  if (url.pathname === '/api/country') {
    const slug = normalizeKeyPart(url.searchParams.get('slug'), 120);
    const currentPage = page(url.searchParams.get('page'));
    await cachedJson(
      request,
      response,
      'country:' + slug + ':' + currentPage,
      () => buildCountry(slug, currentPage),
      300
    );
    return;
  }

  if (url.pathname === '/api/search') {
    const keyword = normalizeKeyword(url.searchParams.get('keyword'));
    const currentPage = page(url.searchParams.get('page'));
    await cachedJson(
      request,
      response,
      'search:' + keyword.toLowerCase() + ':' + currentPage,
      () => buildSearch(keyword, currentPage),
      60
    );
    return;
  }

  if (url.pathname === '/api/categories') {
    await cachedJson(
      request,
      response,
      'taxonomy:genres',
      () => buildTaxonomy('genres'),
      3600
    );
    return;
  }

  if (url.pathname === '/api/countries') {
    await cachedJson(
      request,
      response,
      'taxonomy:countries',
      () => buildTaxonomy('countries'),
      3600
    );
    return;
  }

  const movieMatch = url.pathname.match(/^\/api\/movie\/([^/]+)$/);
  if (movieMatch) {
    const slug = decodeURIComponent(movieMatch[1]);
    const result = await getOrBuild(
      'movie:' + slug,
      () => buildMovie(slug),
      { ttl: 300 }
    );
    observeCache(result.cacheStatus);
    if (!result.data) {
      json(response, request, 404, { error: 'Movie not found' }, {
        'cache-control': 'public, max-age=30, stale-while-revalidate=60'
      });
      return;
    }
    json(response, request, 200, result.data, {
      'cache-control': 'public, max-age=60, stale-while-revalidate=' + config.responseCacheStaleSeconds + ', stale-if-error=' + config.responseCacheStaleSeconds,
      'x-blueflare-cache': result.cacheStatus
    });
    return;
  }

  const recommendationMatch = url.pathname.match(
    /^\/api\/recommendation\/(movie|tv)\/(\d+)$/
  );
  if (recommendationMatch) {
    const mediaType = recommendationMatch[1];
    const tmdbId = Number(recommendationMatch[2]);
    await cachedJson(
      request,
      response,
      'recommendation:' + mediaType + ':' + tmdbId,
      () => buildRecommendations(mediaType, tmdbId),
      900
    );
    return;
  }

  json(response, request, 404, { error: 'Not found' });
}

await migrate();

const server = http.createServer((request, response) => {
  const started = Date.now();
  route(request, response).catch((error) => {
    console.error('[api] request failed', error);
    if (!response.headersSent) {
      json(response, request, 503, {
        error: 'Catalog temporarily unavailable'
      }, { 'cache-control': 'no-store' });
    } else {
      response.destroy(error);
    }
  }).finally(() => {
    const pathname = new URL(request.url || '/', 'http://blueflare.local').pathname;
    observeRequest(pathname, response.statusCode, Date.now() - started);
  });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log('[api] listening on 0.0.0.0:' + config.port);
});

async function shutdown(signal) {
  console.log('[api] received ' + signal + ', shutting down');
  server.close();
  await Promise.allSettled([closeCache(), closeDatabase()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
