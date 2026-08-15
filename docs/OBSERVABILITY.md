# Blueflare observability runbook

## Runtime signals

- `https://img.bluesia.net/api/health`: PostgreSQL/Valkey latency, provider health and cache version. It is `no-store`.
- `https://img.bluesia.net/api/metrics`: in-process request, error, latency and Valkey cache-status counters. Set `METRICS_TOKEN` and send it as `x-blueflare-metrics`; the endpoint stays `no-store` and is disabled when the token is empty.
- API response header `x-blueflare-cache`: `VALKEY-HIT`, `VALKEY-STALE-SERVED`, `VALKEY-HIT-AFTER-LOCK`, `VALKEY-REFRESH`, or `POSTGRES`.
- Cloudflare: track `CF-Cache-Status`/`Age` separately for Next static assets, public HTML, catalog JSON and signed images. Do not blend search, health, metrics or video traffic into cache-hit targets.

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
