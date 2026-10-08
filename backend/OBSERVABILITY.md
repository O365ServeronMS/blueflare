# Blueflare observability runbook

## Contents

- [Runtime signals](#runtime-signals)
- [Background job signals](#background-job-signals)
- [Postgres diagnostics](#postgres-diagnostics)
- [Provider reliability](#provider-reliability)
- [Suggested alerts](#suggested-alerts)
- [Worker exit and host-stall response](#worker-exit-and-host-stall-response)

## Runtime signals

- `https://img.bluesia.net/api/health`: PostgreSQL/Valkey latency, provider health, cache version and the sync-worker heartbeat. It is `no-store`. A missing, failed or stale worker heartbeat makes the endpoint return `503`; a fresh `degraded` heartbeat remains live but needs investigation.
- `https://img.bluesia.net/api/metrics`: in-process request, error, latency and Valkey cache-status counters. Set `METRICS_TOKEN` and send it as `x-blueflare-metrics`; the endpoint stays `no-store` and is disabled when the token is empty.
- API response header `x-blueflare-cache`: `VALKEY-HIT`, `VALKEY-STALE-SERVED`, `VALKEY-HIT-AFTER-LOCK`, `VALKEY-REFRESH`, or `POSTGRES`.
- Auth rate limits: if Valkey is unavailable, `[auth] rate-limit store unavailable, using memory counters` is logged (at most once per 5 s backoff) and login/signup limits fall back to per-process memory counters. A 503 `{error:"busy"}` from `/api/auth/*` means the scrypt `HashGate` is saturated (limits and buckets: `backend/ARCHITECTURE.md`).
- Cloudflare: track `CF-Cache-Status`/`Age` separately for Next static assets, public HTML, catalog JSON and images. Do not blend search, health, metrics or video traffic into cache-hit targets.

## Background job signals

The worker publishes `catalog:worker:heartbeat` to Valkey after startup and every
cycle. Its TTL is two sync intervals plus five minutes (35 minutes at the default
15-minute interval), so a stopped or wedged worker becomes visible even when the
container still exists. `/api/health` is the supported way to consume it; do not
alert directly on the Valkey key.

The remaining signals are log lines, so `docker logs` is the whole interface.

| Log prefix | Meaning | Alert condition |
| --- | --- | --- |
| `[worker] duplicate merge ok <drop> => <keep> evidence=… [rename=…]` | one merge applied | none |
| `[worker] duplicate merge merged=… skipped=… remaining=… ambiguous=… evidence=… durationMs=…` | per-cycle merge summary | see the ALERT line |
| `[worker] ALERT duplicate merge …` (warn) | failed/stale merges, ambiguous pairs, `remaining` above `MERGE_ALERT_PENDING` (200), or three cycles without progress | any occurrence |
| `[worker] tmdb ai match mode=… scope=… requests=… checked=… verified=… unverifiable=… none=… error=… merged=… assigned=… tokens=prompt/output/thoughts models=…` | one ranked batch (the AI match loop, or the sync cycle when `TMDB_MATCH_AI_LOOP=false`) | none; watch `error=` rising |
| `[worker] tmdb ai match loop: blocked\|idle` | logged only when the loop enters that state. `blocked`: the rotation has no usable key/model right now. `idle`: backlog empty | `blocked` for a long time |
| `[worker] tmdb ai match batch failed`, `… assign failed for <slug>`, `… could not record run for <slug>`, `… loop tick failed`, `… invalidation failed` (warn) | a batch, assignment, run record, tick or invalidation failed | repeated occurrences |
| `[worker] ai quota ledger save failed\|could not load` (warn) | the quota ledger is counted from memory until it recovers | persistent |
| `[worker] tmdb ai match: AI quota exhausted, resuming next cycle` | AI match stopped for the cycle (loop off only) | none |
| `[worker] tmdb identity promote checked=… assigned=… merged=… blocked=… conflict=…` | per sync cycle when `TMDB_IDENTITY_MODE=apply` promoted something | none; a rising `conflict` needs review |
| `[worker] tmdb identity promotion failed` (warn) | promotion pass failed | any occurrence |
| `[worker] image prewarm selected=… cached=… warmed=… failed=… bytes=… durationMs=…` | prewarm pass. Steady state is `warmed=0` with everything `cached` in tens of milliseconds: the hot set is already on disk and no request was made. A persistently high `warmed` means the catalog is churning. `failed` names the reason (`errors=HTTP 404x3`). `declined=` means the run stood down on purpose: the cache directory was unreadable or free disk was under `IMAGE_PREWARM_MIN_FREE_BYTES` | non-zero `failed`, or `declined=` |
| `[api] image cache sweep files=… bytes=… evicted=… freedBytes=… tmpRemoved=…` | hourly sweep. Expected to be a no-op with `evicted=0`; it only acts once the cache passes `IMAGE_CACHE_MAX_BYTES` | non-zero `tmpRemoved`: image builds are crashing between write and rename |
| `[backup] dump … / offsite s3://… / prune local … / prune remote …` | one cycle per `BACKUP_INTERVAL_SECONDS` | `upload failed`: the dump exists only on the VPS; the container exits non-zero so it shows in `docker ps -a` |
| `[auth] rate-limit store unavailable, using memory counters` | Valkey down, login/signup limits are per-process | repeated beyond the 5 s backoff |

`IMAGE-BUILD` versus `IMAGE-DISK-HIT` in `/api/metrics` is not a normal hit-rate:
Cloudflare holds images for a year, so the origin mostly sees each asset once and
`IMAGE-BUILD` legitimately dominates. Prewarming is what keeps that first request
off a real user, so judge it by the prewarm log rather than by this ratio.

## Postgres diagnostics

Migration `004_catalog_query_indexes.sql` (catalog read-path indexes plus the `pg_trgm` extension, applied by the API's migration runner at startup) must be in place first; then run these read-only checks during a low-traffic window. The pg_stat_statements query is optional and requires the extension to be enabled in PostgreSQL:

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
- repeated `[auth] rate-limit store unavailable` lines (Valkey down) or sustained 503 `busy` from `/api/auth/*` (scrypt `HashGate` saturated).
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

A cycle that never settles is treated the same way. Each cycle has a deadline
equal to the heartbeat TTL — past that point `/api/health` already reports the
worker as `missing` — and each heartbeat write has a 10-second bound. On expiry
the worker writes `failed`, closes its pools with a 5-second cap and exits
non-zero so `restart: unless-stopped` replaces it. Before this, a promise lost
during a host freeze (2026-09-10, CPU steal 84%) left the process alive, idle,
and `unhealthy` indefinitely, because Docker does not restart unhealthy
containers.

If CPU steal, block-device await, soft-lockups, `containerd-shim`/`runc` stalls, or
Docker restart-manager task conflicts coincide with the exit, open a VPS-provider
ticket with the preserved timestamps, `sar` output and kernel/Docker excerpts.
Do not restart `containerd` automatically: it disrupts every workload and would
erase useful evidence. Move the workload to a different physical host only after
the provider supplies a root-cause statement or the symptoms recur under normal
load; validate restore and the public health endpoint after the move.
