const startedAt = Date.now();
const routeStats = new Map();
const cacheStats = new Map();

function routeKey(pathname) {
  if (pathname.startsWith('/i/m/')) return '/i/m/*';
  if (pathname.startsWith('/i/d/')) return '/i/d/*';
  if (pathname.startsWith('/api/movie/')) return '/api/movie/:slug';
  if (pathname.startsWith('/api/recommendation/')) return '/api/recommendation/:type/:id';
  if (pathname === '/api/health' || pathname === '/api/metrics' || pathname === '/healthz') return pathname;
  if (pathname.startsWith('/api/')) return '/api/*';
  return '/other';
}

export function observeCache(cacheStatus) {
  const key = String(cacheStatus || 'UNKNOWN');
  cacheStats.set(key, (cacheStats.get(key) || 0) + 1);
}

export function observeRequest(pathname, statusCode, latencyMs) {
  const key = routeKey(pathname);
  const current = routeStats.get(key) || { count: 0, errors: 0, totalLatencyMs: 0, maxLatencyMs: 0 };
  current.count += 1;
  if (Number(statusCode) >= 500) current.errors += 1;
  current.totalLatencyMs += Number(latencyMs) || 0;
  current.maxLatencyMs = Math.max(current.maxLatencyMs, Number(latencyMs) || 0);
  routeStats.set(key, current);
}

export function metricsSnapshot() {
  const routes = Object.fromEntries([...routeStats.entries()].map(([route, value]) => [route, {
    ...value,
    meanLatencyMs: value.count ? Math.round(value.totalLatencyMs / value.count) : 0
  }]));
  return {
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    updatedAt: new Date().toISOString(),
    routes,
    cache: Object.fromEntries(cacheStats.entries())
  };
}
