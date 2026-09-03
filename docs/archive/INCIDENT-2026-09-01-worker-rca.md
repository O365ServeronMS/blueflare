# Archived incident: sync worker exits on 2026-09-01

> Historical RCA recorded on 2026-09-03. This is evidence for follow-up, not an active operating procedure; use `docs/OBSERVABILITY.md` for response steps.

## Impact

The `blueflare-worker` Node process exited three times while PostgreSQL acquisition
timed out. The third exit was not recovered by Docker, leaving scheduled provider
syncs unavailable until the Docker runtime was restarted during host recovery on
2026-09-03. API read traffic continued from the catalog database/cache.

## Application trigger

At 07:15:52Z, 08:04:47Z and 09:08:11Z, worker logs recorded:

```text
Error: Connection terminated due to connection timeout
    at getHeroTrendingRefreshState (src/worker.js:223)
```

Before this incident, the first database read in the hero refresh ran outside the
worker cycle's error boundary. A transient `pg-pool` failure therefore became a
process exit. The remediation retries only classified dependency failures and
publishes a Valkey heartbeat consumed by `/api/health`.

## Host evidence

- No worker OOM kill was recorded; memory usage was about 37% and disk capacity was about 40% used.
- `sar` showed severe host contention at the same local times: CPU steal 73.53% at 15:20, 69.73% at 16:05 and 88.11% at 17:10; block-device await reached 16,006.63 ms, 17,637.21 ms and 4,344 ms respectively.
- Kernel logs recorded 138 soft-lockup events on September 1 and 124 on September 2, involving `bio_aof`, `kworker`, PostgreSQL, `containerd-shim` and `runc`.
- Docker attempted an `unless-stopped` restart at 09:09:56Z, then logged a restart-manager task `AlreadyExists` conflict while cleaning up a missing container task.

The evidence supports hypervisor/host I/O starvation as the root infrastructure
cause. The exact physical-host cause is controlled by the VPS provider; an
application container restart alone is not a remediation.

## Provider-ticket draft

Subject: `2026-09-01 KVM CPU steal / block I/O stall caused container workload outage`

Report that this VPS experienced repeated PostgreSQL connection timeouts followed
by a Docker restart-manager task conflict from 07:15Z to 09:10Z. Attach the
timestamped `sar -u ALL -d -q`, `journalctl -k`, and Docker/containerd excerpts.
Ask the provider to investigate host-node CPU scheduling and storage latency,
confirm whether the instance was affected by a host incident, and offer migration
to a healthy physical node if they cannot provide a durable remediation.
