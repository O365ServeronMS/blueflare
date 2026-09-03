# Blueflare observability runbook

## Runtime signals

- `https://img.bluesia.net/api/health`: PostgreSQL/Valkey latency, provider health, cache version and the sync-worker heartbeat. It is `no-store`. A missing, failed or stale worker heartbeat makes the endpoint return `503`; a fresh `degraded` heartbeat remains live but needs investigation.
- `https://img.bluesia.net/api/metrics`: in-process request, error, latency and Valkey cache-status counters. Set `METRICS_TOKEN` and send it as `x-blueflare-metrics`; the endpoint stays `no-store` and is disabled when the token is empty.
- API response header `x-blueflare-cache`: `VALKEY-HIT`, `VALKEY-STALE-SERVED`, `VALKEY-HIT-AFTER-LOCK`, `VALKEY-REFRESH`, or `POSTGRES`.
- Cloudflare: track `CF-Cache-Status`/`Age` separately for Next static assets, public HTML, catalog JSON and images. Do not blend search, health, metrics or video traffic into cache-hit targets.

## Background job signals

The worker publishes `catalog:worker:heartbeat` to Valkey after startup and every
cycle. Its TTL is two sync intervals plus five minutes (35 minutes at the default
15-minute interval), so a stopped or wedged worker becomes visible even when the
container still exists. `/api/health` is the supported way to consume it; do not
alert directly on the Valkey key.

The remaining signals are log lines. All three are one line per run, so `docker
logs` is the whole interface.

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
- worker heartbeat `status=degraded` for more than 5 minutes, or worker health reason `missing`, `failed`, `stale` or `invalid` on one check.
- provider consecutive failures >= 3.
- API 5xx rate > 1% over 5 minutes.
- `POSTGRES` cache builds > 5% of catalog reads after warmup.
- image cache responses returning 5xx or repeated source fetch failures.
- host CPU steal > 10% for 5 minutes, disk await > 100 ms for 5 minutes, or any kernel `soft lockup`/Docker `restartmanger wait error` event. These need host/provider escalation, not an application restart.

## Worker exit and host-stall response

When the public health endpoint reports a stale worker, first preserve evidence
before changing the host. Run the following on the VPS for the affected date
(`DD` is the day-of-month used by sysstat):

```bash
cd /opt/stacks/blueflare
docker compose ps -q worker | xargs docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}} restarts={{.RestartCount}}'
docker compose logs --timestamps --since '2h' worker
journalctl -u docker -u containerd --since '2 hours ago'
journalctl -k --since '2 hours ago' | grep -Ei 'soft lockup|blocked for|oom|i/o error'
sar -u ALL -d -q -f /var/log/sysstat/saDD
```

Classify `ECONNRESET`, connection timeout/refused and PostgreSQL startup/recovery
codes as dependency-transient: the worker now retries these with capped
exponential backoff and writes a `degraded` heartbeat. Any other failure is
intentional fail-fast: it writes `failed`, exits non-zero and lets Compose expose
the bad release. Do not add a blanket catch or an infinite crash loop.

If CPU steal, block-device await, soft-lockups, `containerd-shim`/`runc` stalls, or
Docker restart-manager task conflicts coincide with the exit, open a VPS-provider
ticket with the preserved timestamps, `sar` output and kernel/Docker excerpts.
Do not restart `containerd` automatically: it disrupts every workload and would
erase useful evidence. Move the workload to a different physical host only after
the provider supplies a root-cause statement or the symptoms recur under normal
load; validate restore and the public health endpoint after the move.
