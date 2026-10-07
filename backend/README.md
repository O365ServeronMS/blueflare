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

Provider and rating-enrichment traffic is never on a browser request path:

    NguonC (primary) ----\
                          -> sync worker -> canonical movies -> ViewModels
    KKPhim (fallback) ---/

    MDBList (tomatoes + audience) -> worker -> dedicated movie score columns

Video bytes are never proxied. The API returns provider embed/HLS metadata and
the browser connects to the selected provider.

## Services

- api: HTTP API, response cache, image cache origin and its hourly sweep, health endpoint.
- worker: provider sync, normalization, deterministic deduplication, MDBList
  rating enrichment, health tracking, home ViewModel precomputation, image
  cache prewarming, and the TMDB identity work (cast-verified match, promotion
  to `tmdb_id`, and the separate AI match loop; see "TMDB AI match").
- postgres: canonical movies and provider provenance.
- valkey: final JSON responses and cache-version invalidation.
- image-cache-init: one-shot `mkdir`+`chown` of the image cache directory. It
  exits 0 and stays exited; `api` waits for that completion because it runs as
  uid 1000 and cannot write a root-owned bind mount.
- backup: scheduled dump to an S3-compatible store. Exits 0 and stays exited
  when `BACKUP_ENABLED=false`.

The API is published only on 127.0.0.1:3200. Caddy is the public TLS boundary.

## First start

Create the runtime environment:

    cd /opt/stacks/blueflare
    cp .env.example .env

Replace POSTGRES_PASSWORD and IMAGE_SIGNING_SECRET with independent random
values. DATABASE_URL must contain the same PostgreSQL password.

Validate and start:

    docker compose --env-file .env -f compose.yml config
    docker compose --env-file .env -f compose.yml up -d --build
    docker compose --env-file .env -f compose.yml ps
    curl -fsS http://127.0.0.1:3200/api/health

The worker imports the configured number of newest pages immediately, starting
with NguonC and then filling gaps from KKPhim.

## Account hardening

Auth routes are rate limited (Valkey counters, in-memory fallback) and scrypt is
capped so it cannot starve the libuv threadpool shared with image I/O and sharp.
Limits are in `docs/backend-architecture.md`; all vars must also be in the stack `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_HASH_CONCURRENCY` | 2 | concurrent scrypt hashes; keep well below `UV_THREADPOOL_SIZE` |
| `AUTH_HASH_QUEUE` | 16 | waiting hashes before 503 `busy` |
| `AUTH_REGISTER_GLOBAL_PER_HOUR` | 300 | global signups per hour, then 429 |
| `UV_THREADPOOL_SIZE` | 8 | set on `api` in `infra/compose.yml` |

## Crawl, ordering, and storage

Each worker cycle first refreshes the newest `SYNC_PAGES_PER_RUN` pages, then
advances one or more low-priority backfill pages per provider. Backfill starts
after the head pages, persists its position in `crawl_checkpoints`, and resumes
after a restart. Browser requests never wait for a provider crawl.

A list item whose `modified` time equals the stored `provider_updated_at` (and
whose stored source already has streams) is skipped without a detail fetch; the
head log reports it as `skippedUnchanged`. When a detail fetch fails, an existing
source with streams is left untouched instead of being overwritten by the
list-item summary. A stored source whose movie has no usable thumb (empty, or on a
host in `IMAGE_DEAD_HOSTS`) is never skipped.

Image heal: NguonC moved its CDN from `phim.nguonc.com` (now 404) to
`img.nguonc.com`, and providers keep retaining the old URL when a fresh one is
empty. Each cycle, `healImageSources` walks NguonC list pages (checkpoint lane
`image-heal`, `IMAGE_HEAL_PAGES_PER_RUN` pages per cycle) and replaces thumb/poster
source URLs that are empty or on a dead host with the list item's current ones.
Once that walk completes it runs one pass copying another provider's stored image
(e.g. KKPhim) into movies that still have none. Set `IMAGE_HEAL_ENABLED=false` to
turn it off; delete the `crawl_checkpoints` row (nguonc / `image-heal`) to re-run.

Image host check: once a day (`IMAGE_HOST_CHECK_INTERVAL_MS`) the worker probes
`IMAGE_HOST_CHECK_SAMPLES` random stored image URLs of every `IMAGE_ALLOWED_HOSTS`
host (ranged GET, body discarded) and records a verdict in `image_host_health`. A
host counts as dead only when every sample is 404/410/DNS-gone; 429/5xx/timeouts are
inconclusive, one live sample clears it, and a simultaneous failure of all hosts is
treated as our own network problem. After `IMAGE_HOST_DEAD_AFTER_CHECKS` consecutive
dead checks the host leaves the effective allowlist (api and worker reload it every
few minutes), and, once image-heal has finished, the worker clears its links from
`movies` (up to `IMAGE_HOST_PURGE_LIMIT` per run, skipping images still in the disk
cache) and deletes its unreferenced `image_assets` in batches of 1000 (every column
referencing `image_assets` needs an index, or each delete triggers sequential scans;
see migration `022_asset_fk_indexes.sql`). `IMAGE_DEAD_HOSTS` is the static
override. To reset a host, delete its `image_host_health` row.

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

## TMDB reviews

Worker-only pass (`tmdbReviewsSync.js`, after the credits pass in each sync
cycle); no request path ever calls TMDB. Reviews are re-fetchable, so they are
not irreplaceable state.

- Candidates: ready rows with a verified TMDB identity (`tmdb_id` + media type,
  or a `verified` cast match), oldest `reviews_checked_at` first, at most
  `TMDB_REVIEWS_LIMIT` per cycle.
- Fetch: up to 2 TMDB pages (`en-US`) per title. Reviews whose plain text is
  under 40 characters are dropped; bodies are converted from markdown/HTML to
  plain text, truncated to 4000 characters, and at most
  `TMDB_REVIEWS_MAX_PER_MOVIE` are kept. No avatars are stored.
- Refresh: a successful check (including an empty list or a TMDB 404) is
  repeated after 7 days (`TMDB_REVIEWS_REFRESH_MS`). Any other failure retries
  after 6 hours (`TMDB_REVIEWS_RETRY_MS`) and keeps the stored reviews.
- Storage: `movie_reviews` (migration `025_tmdb_reviews.sql`), plus
  `movies.reviews_checked_at` / `reviews_next_retry_at`. `score` (0-100, from
  rating, length and recency decay) and `has_spoiler` (English heuristic) are
  computed at write time.
- Order on the API: `has_spoiler` first, then 10-wide score bands, then a
  shuffle stable per slug and UTC day (`reviewOrder.js`). Spoiler reviews are
  not hidden, only flagged.
- Env (defaults): `TMDB_REVIEWS_ENABLED=true`, `TMDB_REVIEWS_LIMIT=200`,
  `TMDB_REVIEWS_CONCURRENCY=3`, `TMDB_REVIEWS_REFRESH_MS=604800000`,
  `TMDB_REVIEWS_RETRY_MS=21600000`, `TMDB_REVIEWS_MAX_PER_MOVIE=40`. Also
  requires `TMDB_API_KEY`.
- Invalidation: changed titles drop `movie:<slug>` and
  `reviews:<slug>:{1..4}:{5,10}`; deeper pages expire on the 60s TTL.

### Vietnamese translation of reviews

Separate worker-only pass (`reviewTranslateSync.js`, right after the reviews
pass in each sync cycle). It translates the English `content` to Vietnamese
through an ordered provider chain (`TRANSLATE_PROVIDER`, `translate.js`): by
default Gemini (`gemini`, AI Studio free tier, rotating across several models),
optionally the free, unofficial Google gtx endpoint (`google-gtx`) as a fallback;
no request path calls either. Only public TMDB
review text is sent to a provider. A provider can start refusing us at any time
(gtx is unofficial, free quotas run out), so everything fails open: the API simply serves English.

- Queue: reviews of ready rows with no fresh translation (`content_vi IS NULL`
  or `translated_hash` differs from `content_hash`), oldest first, at most
  `TRANSLATE_REVIEWS_PER_CYCLE` per cycle, skipping rows backing off
  (`translate_retry_at`). Sequential, spaced per provider: `TRANSLATE_DELAY_MS`
  for gtx; Gemini spaces each model by its own RPM (see below). Long text is
  split into chunks of at most 4000 chars on paragraph/sentence boundaries and
  rejoined keeping line breaks; transient errors retry twice with backoff.
- Backlog: after the first deploy every stored review is pending, so the
  backlog drains over many cycles (150 per cycle by default), not at once. A
  review whose translation equals the source is stored as `''` so it leaves the
  queue without showing a translation.
- Cooldown: a blocked provider (gtx: HTTP 429/403 or an HTML captcha/consent
  page) cools down alone and the same review continues on the next provider in
  the chain. The pass ends only when no provider is available, or after
  `TRANSLATE_MAX_CONSECUTIVE_ERRORS` provider-level failures in a row (it then
  pauses for `TRANSLATE_COOLDOWN_MS`). Cooldown state is in memory (a worker
  restart retries once). A single failing review backs off for the same period
  without blocking the rest.
- Gemini rotation: `GEMINI_MODELS` is an ordered `id[:rpm]` list (default 2
  free-tier Flash-Lite models), each with its own quota. A
  request uses the first model that is not cooling down and whose spacing
  (`ceil(60s/rpm)` + 250 ms, never below `GEMINI_DELAY_MS`) has elapsed; it waits on the best model only when that takes under
  3 s, otherwise uses the next ready one, and sleeps only when every model is
  waiting on spacing. 429 per-minute: that model cools for `retryDelay`
  (1s..`GEMINI_COOLDOWN_MS`); 429 per-day (`PerDay` in the body, or a delay over
  10 min): exhausted until 00:00 America/Los_Angeles, logged once as
  `gemini model X exhausted until <iso>`; 404 / "model not supported": that
  model is off for `GEMINI_COOLDOWN_MS` for every key; 401/403 (or invalid-key
  400): only that key is off for `GEMINI_COOLDOWN_MS` (logged once as
  `gemini k3 (9f00aa) disabled: key rejected (HTTP 403)`). When every
  (key, model) pair is parked, or every key is rejected, the
  provider is blocked (cooldown = earliest return, capped by
  `GEMINI_COOLDOWN_MS`) and the chain moves on. A
  safety/recitation/truncation answer, or one with stray CJK characters for a source without any, from one model is tried on the next model;
  when all refuse (`TranslateContentError`) it is a per-review failure that does
  NOT count toward the consecutive-error limit. Per-model state is in memory. A
  empty `GEMINI_API_KEYS` skips Gemini silently (one warning is logged if no
  provider is usable at all, so the default config without a key translates
  nothing).
- Multiple keys: `GEMINI_API_KEYS` (comma list, secret) is trimmed and deduped,
  order kept. Quota is per Google project,
  so use keys from different accounts/projects. Selection is "best model
  first": for each model in order the keys are tried in order, and the next
  model is used only when no key can serve the current one (the under-3 s wait
  rule applies to the best model's keys). Spacing, RPM and daily exhaustion are
  per (key, model) and live in `state.translators` (`pairs`, `models`, `keys`).
  Logs name keys only as `k<n> (<first 6 hex of sha256(key)>)`; the key is sent
  only in the `x-goog-api-key` header and is never logged or put into an error.
  The DB still stores just `gemini:<model id>`.
- Log line: `[worker] review translate checked= ok= failed= blocked=
  providers=gemini:N models=gemini-3.5-flash-lite:A,gemini-3.1-flash-lite:B
  keys=k1:N,k2:M` (`keys=` only when Gemini answered).
  `translate_provider` stores `gemini:<model id>` or `google-gtx`.
- Storage: migration `026_review_translation.sql` adds `content_vi`,
  `translated_hash`, `translated_at`, `translate_failed_at`,
  `translate_retry_at` to `movie_reviews`; migration
  `027_review_translation_provider.sql` adds `translate_provider` (which
  provider produced the translation; internal only, never in the API, NULL for
  older rows). `content` stays the English source;
  `has_spoiler` and `score` are computed on it, not on the translation. A
  translation is only written (and served) while `translated_hash` equals the
  current `content_hash`, so a TMDB refresh that rewrites the text hides the old
  translation until it is retranslated.
- API: each review has `contentVi` (string, or `null` when there is no fresh
  translation); see the reviews contract in `docs/backend-architecture.md`.
  Changed titles are invalidated the same way as a reviews change.
- Env (defaults): `TRANSLATE_ENABLED=true`, `TRANSLATE_PROVIDER=gemini`,
  `TRANSLATE_REVIEWS_PER_CYCLE=150`, `TRANSLATE_DELAY_MS=1000`,
  `TRANSLATE_MAX_CONSECUTIVE_ERRORS=5`, `TRANSLATE_COOLDOWN_MS=3600000`,
  `TRANSLATE_TIMEOUT_MS=10000`. `TRANSLATE_PROVIDER` is a comma-separated
  ordered chain, e.g. `gemini,google-gtx`. Gemini: `GEMINI_API_KEYS` (secret, comma list;
  empty disables it), `GEMINI_MODELS` (see `.env.example`; `GEMINI_MODEL` only
  when it is empty), `GEMINI_TIMEOUT_MS=30000`, `GEMINI_DELAY_MS=0` (floor),
  `GEMINI_COOLDOWN_MS=21600000`. Remember to add the keys to the
  stack `.env`.
- The rotation itself (keys x models, spacing, cooldowns, Pacific-day helpers)
  lives in `geminiRotation.js` and is shared with the TMDB AI match pass, which
  owns a separate instance (own keys, own state) of it.

## TMDB AI match

Worker-only; no request path calls TMDB or Gemini. For ready titles with no `tmdb_id`
the pass fetches real TMDB candidates (`tmdbMatchAi.js`), has Gemini rank them, and lets an
independent gate decide. Gemini never supplies an id, only picks among fetched candidates.

- Keys and models: `TMDB_MATCH_GEMINI_API_KEYS` (secret, comma list, ideally from
  different Google projects) and `TMDB_MATCH_GEMINI_MODELS` (`id[:rpm[:rpd]]`). It never
  falls back to `GEMINI_API_KEYS`. The pass runs only with `TMDB_MATCH_AI_ENABLED=true`,
  non-empty keys, `TMDB_MATCH_AI_MODE` other than `off`, and `TMDB_ENABLED` plus a TMDB key.
- Gate (`decideAiMatch`, pure): the model's pick is `verified` only if tier 1 holds (catalog
  cast >= 2 and >= 2 names overlap the candidate's cast, year and size compatible; TV season
  not above the candidate's season count) or tier 2 holds (exact name + year + size, no other
  candidate passes the same test; a row without a year is refused). Otherwise `unverifiable`
  (a pick the gate refused) or `none` (no candidates, no pick). Every verdict is recorded in
  `tmdb_match_ai_runs` (`status` + `outcome`, migration 029).
- Dry-run vs apply: `TMDB_MATCH_AI_MODE=dry-run` (default) only writes `tmdb_match_ai_runs`.
  `apply` also calls `assignTmdbIdentity` (source `inferred`) for verified picks: it writes
  the id on the row or merges it into the row already holding that identity. Independent of
  `TMDB_IDENTITY_MODE`, which only governs promotion of the cast-verified `tmdb_match_*`
  rows. In apply mode a title whose last run was a dry-run `verified` is examined again.
- Retry windows: `none`, `unverifiable` and verified-but-not-applied results are not
  re-examined for `TMDB_MATCH_AI_RETRY_MS` (14 days); errors wait
  `TMDB_MATCH_AI_ERROR_RETRY_MS` (6 h). Rows with a cast of two or more go first.
- Loop: `tmdbMatchAiLoop.js` wakes every `TMDB_MATCH_AI_LOOP_MS` (60 s) and ranks one
  token-packed batch per tick; `TMDB_MATCH_AI_LOOP=false` runs the older whole pass inside
  the sync cycle instead (`TMDB_MATCH_AI_LIMIT` titles per cycle). The scope `priority`
  (films first seen within `TMDB_MATCH_AI_FRESH_MS`, 3 days, and films whose last run errored)
  runs first; the old backlog (`all`) only runs while more than `TMDB_MATCH_AI_RESERVE_PCT`
  (10, max 90) of the day's request budget remains.
- Batching: films are packed into one request until `TMDB_MATCH_GEMINI_BATCH_TOKENS` (40000,
  estimated chars/3 and corrected from the prompt token count each response reports) or
  `TMDB_MATCH_GEMINI_BATCH_MAX` (40, defaults to the old `TMDB_MATCH_GEMINI_BATCH`) is reached;
  a batch holds one tier only. A request the model refuses is bisected until the offending
  film is alone (then `model-refused`). Thinking tokens: `TMDB_MATCH_GEMINI_THINK_T1=0`
  (films with a cast, 0 = not sent), `TMDB_MATCH_GEMINI_THINK_T2=4096`. Timeout
  `TMDB_MATCH_GEMINI_TIMEOUT_MS=180000`; other failure handling (cooldown, transient park)
  uses the `TMDB_MATCH_GEMINI_*` counterparts of the `GEMINI_*` variables.
- Quota ledger (`geminiQuotaLedger.js`, table `gemini_quota_ledger`, migration 031): per
  key+model counts of requests per Pacific day (`TMDB_MATCH_GEMINI_RPD`, default 20, or the
  model's own `rpd`), RPM spacing from the persisted last request, and a 60 s token window
  (`TMDB_MATCH_GEMINI_TPM`). A request counts when it starts and stays counted if it fails
  or times out. When Google answers a daily-quota 429 the count is raised to the limit
  (`exhaust`) even if the ledger thought some requests were left. Keys are stored only as a
  12-hex sha256 fingerprint. The table is disposable (see Backup and restore).
- Log lines: `[worker] tmdb ai match mode= scope= requests= checked= verified= unverifiable=
  none= error= merged= assigned= tokens=prompt/output/thoughts models=`; the loop logs state
  changes only (`[worker] tmdb ai match loop: quota|blocked|idle`); warnings
  `tmdb ai match batch failed`, `... assign failed for <slug>`, `... could not record run`,
  `[worker] gemini quota ledger save failed|could not load`. Promotion logs
  `[worker] tmdb identity promote checked= assigned= merged= blocked= conflict=`.
- Audit and undo: every assign, merge, blocked and conflict is a row in
  `tmdb_identity_changes` (migration 030; merges point at the `movie_merges` snapshot).
  `node scripts/tmdb-identity-report.mjs <out.csv> [--n 200] [--seed 1] [--tmdb]` is the
  read-only review sample; `node scripts/tmdb-identity-undo.mjs <changeId>` reverses one
  assign or merge (it refuses if the identity changed since) and prints the result. It
  writes to the database only, so the affected slugs must be invalidated afterwards
  (Valkey keys and Next render tags, as the worker does after a sync) or readers keep the
  old page.
- Development scripts (read-only against the catalog, they hit TMDB and Gemini):
  `scripts/tmdb-ai-backtest.mjs` (precision against provider-supplied ids),
  `tmdb-ai-classify.mjs` (breakdown of rows still without identity), `tmdb-ai-dryrun.mjs`
  (dry run of the pass on real rows), `tmdb-ai-quota-probe.mjs` (measures what the keys allow).

## Duplicate merge (NguonC + KKPhim)

`MERGE_DUPLICATES_MODE=dry-run` logs `pairs=`/`ambiguous=` each sync cycle; `apply` merges up to
`MERGE_BATCH_LIMIT` pairs per cycle. A pair needs equal normalized original title, year and media
type, a compatible season, episode totals within 1.5x, agreeing slug bases, and must be one-to-one.
Undo one merge by hand from `movie_merges` (`dropped_row`, `moved_source_ids`, `favorites`, `history`);
delete the matching `movie_slug_aliases` row. `tools/merge-backtest.mjs` is the read-only precision
check, `tools/merge-duplicates.mjs --apply` runs the merge against a scratch `DATABASE_URL`.

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

The dump also carries user accounts, sessions and per-title watch history (tables from
migrations `020_users_sessions.sql` and `021_history_episode.sql`); a restore brings them back with the catalog.
The TMDB identity audit/undo log `tmdb_identity_changes` (migration `030`) is in the dump too. `gemini_quota_ledger`
(migration `031`) is disposable: after a restore without it the ledger counts from zero until Google answers 429.

For a backup outside the schedule:

    /opt/stacks/blueflare/deploy/backup-postgres.sh

### Rebuilding this VPS from nothing

The repository carries everything except secrets and data:

1. Clone the repository and run `infra/scripts/bootstrap-vps.sh`. It regenerates
   `POSTGRES_PASSWORD`, `IMAGE_SIGNING_SECRET`, `FRONTEND_REVALIDATE_SECRET`
   and `METRICS_TOKEN`. `TMDB_API_KEY` (like the Gemini key lists) cannot be regenerated,
   so those keys have to be kept somewhere off the machine.
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

The host `/etc/caddy/Caddyfile` is the only place these two site blocks live;
the repository does not carry `.caddy` files. `infra/scripts/bootstrap-vps.sh` appends
both blocks once (marker-guarded, then `caddy fmt`/`validate`/`reload`), so on a
fresh VPS there is nothing to do by hand. To edit or re-add one later, edit the
Caddyfile directly, then format, validate, and reload:

    sudo caddy fmt --overwrite /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy

Access logs are intentionally omitted from both blocks: a file-log block needs a
writable `/var/log/caddy` owned by the `caddy` user, which turns reload into a
two-step sudo dance and once caused a silent reload failure. `journalctl -u
caddy` is enough for this single-VPS setup.

The image site block proxies to the API port and 404s the account routes
(`bootstrap-vps.sh` skips an existing block, so add the `@account` rule to an
already-deployed Caddyfile by hand):

    img.bluesia.net {
        encode zstd gzip

        # Tài khoản chỉ đi qua proxy Next của phim.bluesia.net (cookie, Origin, IP thật).
        @account path /api/auth/* /api/me /api/me/*
        respond @account 404

        reverse_proxy 127.0.0.1:3200
    }

The `phim.bluesia.net` block also carries an `@authdirect` rule that answers 403 for
`/api/auth/*` unless the peer is in the Cloudflare ranges. `inject_caddy_block`
skips an existing block, so add it to a deployed Caddyfile by hand; the snippet and
ranges are in `docs/CLOUDFLARE_CACHE.md` ("Auth hardening").

Caddy obtains and serves the origin certificate for img.bluesia.net. Once the
route is active, Cloudflare Full (strict) can reach the origin without 525.

The Caddy admin API can load this route immediately, but that does not replace
the privileged `/etc/caddy/Caddyfile` edit: persist the site block before the
next Caddy restart.

### Next.js frontend at phim.bluesia.net

The `frontend` Compose service builds `frontend/Dockerfile`, runs the Next.js
standalone server on container port 3000, and binds it to
`127.0.0.1:${FRONTEND_PORT:-3100}` on the VPS. Caddy proxies the public hostname
to that port; no static directory or rewrite file is used.

Build and restart only the frontend service during a release:

    cd /opt/stacks/blueflare
    docker compose --env-file .env -f compose.yml up -d --build frontend
    docker compose --env-file .env -f compose.yml ps frontend
    curl -fsS http://127.0.0.1:3100/healthz

The Next route `/movie/<slug>` is direct and server-rendered. List and search
page parameters remain part of the URL, including page 2/3/etc. The internal
render-cache invalidation endpoint is reachable only from the Docker network
and requires `FRONTEND_REVALIDATE_SECRET`; Caddy returns 404 for the public
hostname path. The worker splits large invalidation sets into sequential
32-tag requests, and the frontend hard-expires those tags before serving the
next matching request.

Its site block adds the security headers and the 404 for the internal
revalidation path:

    phim.bluesia.net {
        encode zstd gzip

        header {
            -Server
            X-Content-Type-Options "nosniff"
            Referrer-Policy "strict-origin-when-cross-origin"
            X-Frame-Options "DENY"
        }

        @internal_revalidate path /api/internal/revalidate
        handle @internal_revalidate {
            respond 404
        }

        reverse_proxy 127.0.0.1:3100
    }

Format, validate, and reload Caddy using the same host procedure as the image
site. Verify after reload:

    curl -fsSI https://phim.bluesia.net/
    curl -fsSI 'https://phim.bluesia.net/list/phim-le?page=2'
    curl -fsSI https://phim.bluesia.net/movie/example-slug
    curl -fsS https://phim.bluesia.net/healthz

## Cloudflare cache rule

Signed `/i/` images are extension-based assets and use a one-year immutable
origin header. For extensionless JSON endpoints, create one zone Cache Rule from
`infra/cloudflare/cloudflare-cache-rule.json`. It caches only `img.bluesia.net/api/*`,
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
- GET /api/recommendations/:canonicalSlug
- GET /api/movies/:canonicalSlug/reviews?page=1&limit=10 (each review has `contentVi`, null when untranslated; public, cached 60s, key = `reviews:<slug>:<page>:<limit>`; limit default 10, max 20; 404 for unknown slug)
- GET /api/categories
- GET /api/countries
- GET /api/cards?slugs=a,b (public, cached 60s, key = sorted slug list)
- /api/auth/* and /api/me/* (accounts, sessions, favorites, history with last episode; never cached; reachable only via the Next proxy, 404 on img.bluesia.net; 429 rate_limited / 503 busy with Retry-After)
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
    docker compose --env-file .env -f compose.yml logs --tail=100 worker
    curl -fsS http://127.0.0.1:3200/api/home-data
    curl -fsS http://127.0.0.1:3200/api/list?type=phim-le&page=1

Provider documentation verified during implementation:

- NguonC: https://phim.nguonc.com/api-document
- KKPhim: https://kkphim.com/api-document

Representative response fixtures are stored under test/fixtures.

## PostgreSQL container upgrades

`POSTGRES_MOUNT` is the parent directory, not `.../data`, because PostgreSQL
18+ keeps `PGDATA` one level below it at `/var/lib/postgresql/<major>/docker`.
`POSTGRES_VOLUME` is the physical Docker volume name; Compose always mounts it
through the logical `postgres-data` volume. An upgrade can therefore restore
into a new physical volume and leave the prior one untouched for rollback.

Run a major upgrade, or a base-OS change such as Alpine/musl to Trixie/glibc,
as a dump-and-restore maintenance operation. Even when the PostgreSQL major
does not change, the latter changes libc collation behavior, so do not mount an
Alpine data directory directly into the Trixie image when the database uses a
libc locale.

1. Record `/api/health`, row counts, migration names, database size and Valkey
   health. Pull and rehearse the exact target images against a copy of a dump.
2. Stop API and worker, create a final verified dump with
   `infra/scripts/backup-postgres.sh`, and record its checksum.
3. Set `POSTGRES_VOLUME` to a new physical name, start the target image, then
   restore the dump. Verify schema, row counts, indexes and API smoke tests.
4. Start API and worker, run one sync cycle, then inspect migration,
   constraint, pool and serialization errors. Keep the previous volume until a
   successful post-cutover backup and observation window have completed.

To roll back before accepting new writes, point `POSTGRES_IMAGE` and
`POSTGRES_VOLUME` back at the previous pair and recreate PostgreSQL, API and
worker. Do not delete the old volume during the upgrade window.

## Valkey upgrades

Valkey is a rebuildable response cache, but AOF is retained for stale-response
availability. The Compose default caps it at `512mb` so `allkeys-lru` has an
effective bound. Upgrade Valkey separately from PostgreSQL, verify AOF load,
`PING`, key count and API cache hit/miss behavior, then observe logs and memory
for at least 15 minutes. If the existing AOF cannot be loaded, start Valkey on
an empty cache volume; the API will repopulate it from PostgreSQL.

## PgBouncer decision

PgBouncer is intentionally not part of this stack. The API and worker each use one `pg.Pool` capped at 12 connections, while the current PostgreSQL runtime has a limit of 100 and only a few active clients. Transaction pooling would also conflict with the migration's session-level advisory lock. Reconsider it only after measured connection pressure or additional API/worker replicas; any future transaction-pooled deployment must keep migrations on a direct PostgreSQL connection or use transaction-scoped advisory locking.

### Host sysctl for Valkey

`vm.overcommit_memory` is a host-level kernel setting and cannot be applied through this container's Compose namespace. On the Docker host, run as root:

    sysctl -w vm.overcommit_memory=1
    printf '%s\n' 'vm.overcommit_memory=1' > /etc/sysctl.d/99-blueflare-valkey.conf
    sysctl --system

Verify with `sysctl vm.overcommit_memory` returning `1`, then restart Valkey once if the warning was emitted during startup.
