# Blueflare observability runbook

## Runtime signals

- `https://img.bluesia.net/api/health`: PostgreSQL/Valkey latency, provider health and cache version. It is `no-store`.
- `https://img.bluesia.net/api/metrics`: in-process request, error, latency and Valkey cache-status counters. Set `METRICS_TOKEN` and send it as `x-blueflare-metrics`; the endpoint stays `no-store` and is disabled when the token is empty.
- API response header `x-blueflare-cache`: `VALKEY-HIT`, `VALKEY-STALE-SERVED`, `VALKEY-HIT-AFTER-LOCK`, `VALKEY-REFRESH`, or `POSTGRES`.
- Cloudflare: track `CF-Cache-Status`/`Age` separately for Next static assets, public HTML, catalog JSON and images. Do not blend search, health, metrics or video traffic into cache-hit targets.

## Background job signals

These are log lines, not endpoints. All three are one line per run, so `docker logs`
is the whole interface.

- `[worker] image prewarm selected=… cached=… warmed=… failed=… bytes=… durationMs=…`
  Steady state is `warmed=0` with everything `cached` in tens of milliseconds — that
  means the hot set is already on disk and no request was made. A persistently high
  `warmed` means the catalog is churning; a non-zero `failed` names the reason
  (`errors=HTTP 404x3`). `declined=` means the run stood down on purpose: either the
  cache directory was unreadable or free disk was under `IMAGE_PREWARM_MIN_FREE_BYTES`.
- `[api] image cache sweep files=… bytes=… evicted=… freedBytes=… tmpRemoved=…`
  Expected to be a no-op with `evicted=0`; it only acts once the cache passes
  `IMAGE_CACHE_MAX_BYTES`. A non-zero `tmpRemoved` means image builds are crashing
  between write and rename — worth investigating rather than ignoring.
- `[backup] dump … / offsite s3://… / prune local … / prune remote …`
  One cycle per `BACKUP_INTERVAL_SECONDS`. `upload failed` means the dump exists
  only on the VPS, which is the failure mode that matters: the container exits
  non-zero so it is visible in `docker ps -a`.

`IMAGE-BUILD` versus `IMAGE-DISK-HIT` in `/api/metrics` is not a normal hit-rate:
Cloudflare holds images for a year, so the origin mostly sees each asset once and
`IMAGE-BUILD` legitimately dominates. Prewarming is what keeps that first request
off a real user, so judge it by the prewarm log rather than by this ratio.

## Postgres diagnostics

Enable the supplied Phase 4 migration first, then run these read-only checks during a low-traffic window. The pg_stat_statements query is optional and requires the extension to be enabled in PostgreSQL:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autoanalyze, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('movies', 'movie_provider_sources')
ORDER BY relname;

SELECT calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       rows,
       left(query, 240) AS query
FROM pg_stat_statements
WHERE query ILIKE '%FROM movies%'
ORDER BY total_exec_time DESC
LIMIT 20;
```

Use `EXPLAIN (ANALYZE, BUFFERS)` against representative home/list/genre/country/search queries before and after migration. Keep an index only when it reduces execution time or shared reads enough to justify write cost.

## Provider reliability

- `provider_health.consecutive_failures` and `last_error` identify outage/schema drift.
- A single detail/upsert failure is logged and counted without aborting the rest of the sync page.
- HTTP retries are limited to timeouts, 408/425/429 and 5xx; permanent 4xx responses are not retried.
- Strong TMDB/IMDb identity wins over a conflicting provider source, preventing duplicate-key conflicts from stopping canonical sync.

## Suggested alerts

- health status != `ok` for 2 consecutive checks.
- provider consecutive failures >= 3.
- API 5xx rate > 1% over 5 minutes.
- `POSTGRES` cache builds > 5% of catalog reads after warmup.
- image cache responses returning 5xx or repeated source fetch failures.
