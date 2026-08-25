# Blueflare Docker backend

This directory owns the VPS origin and the self-hosted Next.js frontend for
phim.bluesia.net. The runtime path is:

    Browser
        -> Cloudflare proxy/CDN
        -> Caddy on the VPS
        -> Next.js frontend container (127.0.0.1:3100)
        -> Blueflare API (127.0.0.1:3200)
        -> Valkey final-response cache
        -> canonical catalog in PostgreSQL

Provider traffic is never on a browser request path:

    NguonC (primary) ----\
                          -> sync worker -> canonical movies -> ViewModels
    KKPhim (fallback) ---/

Video bytes are never proxied. The API returns provider embed/HLS metadata and
the browser connects to the selected provider.

## Services

- api: HTTP API, response cache, signed image variants, health endpoint.
- worker: provider sync, normalization, deterministic deduplication, health
  tracking, and home ViewModel precomputation.
- postgres: canonical movies and provider provenance.
- valkey: final JSON responses and cache-version invalidation.

The API is published only on 127.0.0.1:3200. Caddy is the public TLS boundary.

## First start

Create the runtime environment:

    cd /opt/stacks/blueflare
    cp .env.example .env

Replace POSTGRES_PASSWORD and IMAGE_SIGNING_SECRET with independent random
values. DATABASE_URL must contain the same PostgreSQL password.

Validate and start:

    sudo docker compose --env-file .env -f compose.yml config
    sudo docker compose --env-file .env -f compose.yml up -d --build
    sudo docker compose --env-file .env -f compose.yml ps
    curl -fsS http://127.0.0.1:3200/api/health

The worker imports the configured number of newest pages immediately, starting
with NguonC and then filling gaps from KKPhim.

## Crawl, ordering, and storage

Each worker cycle first refreshes the newest `SYNC_PAGES_PER_RUN` pages, then
advances one or more low-priority backfill pages per provider. Backfill starts
after the head pages, persists its position in `crawl_checkpoints`, and resumes
after a restart. Browser requests never wait for a provider crawl.

Catalog lists only expose `catalog_state=ready` rows. Their order is
`catalog_sort_at` (the provider's update timestamp), then year and slug; an old
record discovered during backfill cannot appear as a newly updated movie merely
because it was inserted today.

PostgreSQL stores canonical metadata, provider provenance, streams, and image
source URLs only. It does not store image bytes or raw provider payloads. The
runtime image cache is a disposable SSD cache at
`/opt/stacks/blueflare/data/images`. The API mounts it read-write at
`/data/images`; the worker mounts the same path read-only, because prewarming
only needs to see which entries already exist. Existing flat cache files remain
readable; new files are sharded by hash prefix. The two image variants remain
`m` (480 x 720, q75) and `d` (1280 x 720, q75).

Two background jobs keep that cache healthy. The worker prewarms it: after each
sync cycle it reads the same home/list viewmodels the API serves, and asks the
API over the Docker network for any referenced asset not on disk yet, so the
first visitor does not pay the upstream fetch and transcode. The API sweeps it:
hourly it removes orphan `.tmp` files and, only once the cache is over
`IMAGE_CACHE_MAX_BYTES`, evicts least-recently-read entries back under the
target. Eviction lives in the API because the API is the only writer of this
directory.

A remote storage backend for the *image cache itself* is still future work. If
one is added, keep its object keys aligned with the local cache identity,
`images/v2/{variant}/{hash-prefix}/{sha256}.webp`, and do not change the public
`img.bluesia.net/i/{m|d}/…` URL contract.

## Backup and restore

The `backup` service takes a scheduled offsite backup: `pg_dump -Fc`, verified
with `pg_restore --list` before it counts as a backup, uploaded to an
S3-compatible object store, then pruned on both ends (`BACKUP_KEEP_LOCAL` for
fast local restores, `BACKUP_KEEP_REMOTE` for the actual backup). It is off
unless `BACKUP_ENABLED=true`, and sits at `Exited (0)` when off rather than
restart-looping. The image cache is deliberately excluded: it rebuilds itself
from `image_assets` and the worker prewarms it.

The target is any S3-compatible store, so changing provider is an env change
rather than a code change — `BACKUP_S3_*` in `.env.example` lists the endpoint
and region for R2, Backblaze B2, Wasabi, AWS S3 and MinIO.

For a backup outside the schedule:

    /opt/stacks/blueflare/deploy/backup-postgres.sh

### Rebuilding this VPS from nothing

The repository carries everything except secrets and data:

1. Clone the repository and run `deploy/bootstrap-vps.sh`. It regenerates
   `POSTGRES_PASSWORD`, `IMAGE_SIGNING_SECRET`, `FRONTEND_REVALIDATE_SECRET`
   and `METRICS_TOKEN`. `TMDB_API_KEY` is the one value it cannot regenerate,
   so that key has to be kept somewhere off the machine.
2. Fill in the `BACKUP_S3_*` credentials and download the newest object under
   `s3://<bucket>/postgres/`.
3. Bring up PostgreSQL alone, then restore into it:

        pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists <dump>

4. Start the rest of the stack and check `/api/health`, `/healthz`, and one
   list and one detail page.

Skipping the restore is not a shortcut: the site comes up empty and the worker
re-crawls the providers from scratch, which takes weeks and silently loses
every title the providers have dropped in the meantime.

## Caddy

Append deploy/img.bluesia.net.caddy to /etc/caddy/Caddyfile, format, validate,
and reload:

	# Run once; do not append a duplicate block on later deployments.
	cd /opt/stacks/blueflare
	sudo tee -a /etc/caddy/Caddyfile < deploy/img.bluesia.net.caddy
    sudo caddy fmt --overwrite /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy

Caddy obtains and serves the origin certificate for img.bluesia.net. Once the
route is active, Cloudflare Full (strict) can reach the origin without 525.

The Caddy admin API can load this route immediately, but that does not replace
the privileged `/etc/caddy/Caddyfile` edit: persist the site block before the
next Caddy restart.

### Next.js frontend at phim.bluesia.net

The `frontend` Compose service builds `Dockerfile.frontend`, runs the Next.js
standalone server on container port 3000, and binds it to
`127.0.0.1:${FRONTEND_PORT:-3100}` on the VPS. Caddy proxies the public hostname
to that port; no static directory or rewrite file is used.

Build and restart only the frontend service during a release:

    cd /opt/stacks/blueflare
    sudo docker compose --env-file .env -f compose.yml up -d --build frontend
    sudo docker compose --env-file .env -f compose.yml ps frontend
    curl -fsS http://127.0.0.1:3100/healthz

The Next route `/movie/<slug>` is direct and server-rendered. List and search
page parameters remain part of the URL, including page 2/3/etc. The internal
render-cache invalidation endpoint is reachable only from the Docker network
and requires `FRONTEND_REVALIDATE_SECRET`; Caddy returns 404 for the public
hostname path.

Install `deploy/phim.bluesia.net.caddy` in `/etc/caddy/Caddyfile`, then format,
validate, and reload Caddy using the same host procedure as the image site.
Verify after reload:

    curl -fsSI https://phim.bluesia.net/
    curl -fsSI 'https://phim.bluesia.net/list/phim-le?page=2'
    curl -fsSI https://phim.bluesia.net/movie/example-slug
    curl -fsS https://phim.bluesia.net/healthz

## Cloudflare cache rule

Signed `/i/` images are extension-based assets and use a one-year immutable
origin header. For extensionless JSON endpoints, create one zone Cache Rule from
`deploy/cloudflare-cache-rule.json`. It caches only `img.bluesia.net/api/*`,
excludes `/api/health`, and respects each response's origin TTL. Do not apply the
rule to video/embed URLs.

Verify edge behavior with two identical requests:

    curl -sSI https://img.bluesia.net/api/home-data | grep -iE 'cf-cache-status|age|cache-control'
    curl -sSI https://img.bluesia.net/api/home-data | grep -iE 'cf-cache-status|age|cache-control'

The second response should report `CF-Cache-Status: HIT`. A `DYNAMIC` result
means the Cache Rule is not active or the token used to create it lacks
`Zone > Cache Rules > Edit`.


## API contract

- GET /api/health
- GET /api/home-data
- GET /api/list?type=phim-le&page=1
- GET /api/genre?slug=chinh-kich&page=1
- GET /api/country?slug=trung-quoc&page=1
- GET /api/search?keyword=ren%20yu&page=1
- GET /api/movie/:canonicalSlug
- GET /api/recommendation/:movieOrTv/:tmdbId
- GET /api/categories
- GET /api/countries
- GET /i/:variant/:sha256.webp?url=...&sig=...

Only image variants m (480 x 720) and d (1280 x 720) exist. Their identity is
sha256(normalized upstream URL) plus variant; requester host and frontend route
never participate in the cache key.

## Provider identity

Resolution order:

1. exact TMDB ID plus media family;
2. exact IMDb ID plus media family;
3. normalized original title plus year plus media family;
4. normalized Vietnamese title plus year plus media family;
5. controlled token similarity at or above 0.96 with the same year/media family.

NguonC wins presentation metadata. KKPhim fills missing fields and remains an
alternate stream source. Every source retains provider ID, slug, priority,
availability, raw metadata, streams, and success timestamps.

## Verification

    cd /opt/stacks/blueflare
    npm test
    sudo docker compose --env-file .env -f compose.yml logs --tail=100 worker
    curl -fsS http://127.0.0.1:3200/api/home-data
    curl -fsS http://127.0.0.1:3200/api/list?type=phim-le&page=1

Provider documentation verified during implementation:

- NguonC: https://phim.nguonc.com/api-document
- KKPhim: https://kkphim.com/api-document

Representative response fixtures are stored under test/fixtures.

## PostgreSQL 17 -> 18 cutover

Run this as a maintenance operation after testing the exact images on a copy of the backup. The former PostgreSQL 17 volume is removed only after all cutover checks pass; the dump remains the rollback source.

1. Record the baseline: `/api/health`, row counts, migration names, database size, and Valkey health. Pull `postgres:18.6-alpine` and `valkey/valkey:9.1.1-alpine` before the window.
2. Stop the worker so no catalog writes occur during the dump. Create and validate a custom-format dump using `deploy/backup-postgres.sh`.
3. Start PostgreSQL 18 on the new `postgres18-data` volume. Restore the dump, then verify schema, row counts, indexes, and a scratch API smoke test.
4. Stop the API, point the API and worker at PostgreSQL 18, and start the API alone. Require a healthy `/api/health` and successful home, list, detail, and search requests before starting the worker.
5. Run one worker sync cycle and inspect logs for migration, constraint, pool, or serialization errors. Keep the old volume for the rollback window.

Rollback is restore-based after the old volume is removed: stop API/worker, set `POSTGRES_IMAGE=postgres:17.11-alpine`, `POSTGRES_VOLUME=postgres-data`, and `POSTGRES_MOUNT=/var/lib/postgresql/data`, start only PostgreSQL 17, restore the retained custom-format dump into the fresh volume, then start API/worker. Do not roll back after accepting new writes without first deciding how to reconcile those writes.

## Valkey 8 -> 9 cutover

Valkey is a rebuildable response cache, but AOF is retained for stale-response availability. The Compose default caps it at `512mb` so `allkeys-lru` has an effective bound. Upgrade Valkey separately from PostgreSQL, verify AOF load, `PING`, key count, and API cache hit/miss behavior, then observe logs and memory for at least 15 minutes. If the existing AOF cannot be loaded, preserve the old volume and start Valkey 9 on a fresh cache volume; the API will repopulate it from PostgreSQL.

## PgBouncer decision

PgBouncer is intentionally not part of this stack. The API and worker each use one `pg.Pool` capped at 12 connections, while the current PostgreSQL runtime has a limit of 100 and only a few active clients. Transaction pooling would also conflict with the migration's session-level advisory lock. Reconsider it only after measured connection pressure or additional API/worker replicas; any future transaction-pooled deployment must keep migrations on a direct PostgreSQL connection or use transaction-scoped advisory locking.

### Host sysctl for Valkey

`vm.overcommit_memory` is a host-level kernel setting and cannot be applied through this container's Compose namespace. On the Docker host, run as root:

    sysctl -w vm.overcommit_memory=1
    printf '%s\n' 'vm.overcommit_memory=1' > /etc/sysctl.d/99-blueflare-valkey.conf
    sysctl --system

Verify with `sysctl vm.overcommit_memory` returning `1`, then restart Valkey once if the warning was emitted during startup.
