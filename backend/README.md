# Blueflare Docker backend

This directory owns the VPS origin and the self-hosted Next.js frontend for
phim.bluesia.net. Architecture and invariants live in `/CLAUDE.md`; this file
holds backend internals and the operations runbooks. `backend/.env.example` is the
catalogue of every environment variable and its default; the tables below only
explain what the TMDB, translation and OpenRouter variables do.

## Contents

- [Overview](#overview)
- [Services](#services)
- [First start](#first-start)
- [Sync and image jobs](#sync-and-image-jobs)
  - [Crawl, ordering, and storage](#crawl-ordering-and-storage)
  - [Image heal](#image-heal)
  - [Image host check](#image-host-check)
  - [Image cache](#image-cache)
- [TMDB](#tmdb)
  - [Reviews](#reviews)
  - [Review translation](#review-translation)
  - [OpenRouter rotation](#openrouter-rotation)
  - [AI match](#ai-match)
  - [Identity audit and undo](#identity-audit-and-undo)
- [Duplicate merge (NguonC + KKPhim)](#duplicate-merge-nguonc--kkphim)
- [API contract](#api-contract)
- [Provider identity](#provider-identity)
- [Operations](#operations)
  - [Runtime/codebase split](#runtimecodebase-split)
  - [Verification](#verification)
  - [Backup and restore](#backup-and-restore)
  - [Rebuilding this VPS from nothing](#rebuilding-this-vps-from-nothing)
  - [Caddy](#caddy)
  - [Cloudflare cache rule](#cloudflare-cache-rule)
  - [PostgreSQL container upgrades](#postgresql-container-upgrades)
  - [Valkey upgrades](#valkey-upgrades)
  - [Host sysctl for Valkey](#host-sysctl-for-valkey)
  - [PgBouncer decision](#pgbouncer-decision)

## Overview

The runtime path is:

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

| Service | Role |
| --- | --- |
| `api` | HTTP API, response cache, image cache origin and its hourly sweep, health endpoint. Published only on 127.0.0.1:3200. |
| `worker` | Provider sync, normalization, deterministic deduplication, MDBList rating enrichment, health tracking, home ViewModel precomputation, image cache prewarming, and the TMDB identity work (cast-verified match, promotion to `tmdb_id`, and the separate AI match loop; see [AI match](#ai-match)). |
| `postgres` | Canonical movies and provider provenance. |
| `valkey` | Final JSON responses and cache-version invalidation. |
| `image-cache-init` | One-shot `mkdir`+`chown` of the image cache directory. It exits 0 and stays exited; `api` waits for that completion because it runs as uid 1000 and cannot write a root-owned bind mount. |
| `backup` | Scheduled dump to an S3-compatible store. Exits 0 and stays exited when `BACKUP_ENABLED=false`. |

The `frontend` service is covered under [Caddy](#caddy). Caddy is the public TLS
boundary.

## First start

Create the runtime environment:

    cd /opt/stacks/blueflare
    cp .env.example .env

Replace POSTGRES_PASSWORD and IMAGE_SIGNING_SECRET with independent random
values. DATABASE_URL must contain the same PostgreSQL password. `IMAGE_SIGNING_SECRET`
is still required (at least 32 characters in production) because it backs the
legacy signed-image form, see [Image cache](#image-cache).

Validate and start:

    docker compose --env-file .env -f compose.yml config
    docker compose --env-file .env -f compose.yml up -d --build
    docker compose --env-file .env -f compose.yml ps
    curl -fsS http://127.0.0.1:3200/api/health

Repo-side compose validation (with `BLUEFLARE_ENV_FILE` pointing at
`backend/.env.example`) is described under Verification in `/CLAUDE.md`.

The worker imports the configured number of newest pages immediately, starting
with NguonC and then filling gaps from KKPhim.

Account hardening (auth rate limits, the scrypt concurrency cap and their
variables, all of which must also be in the stack `.env`): see
`backend/ARCHITECTURE.md`.

## Sync and image jobs

### Crawl, ordering, and storage

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

Catalog lists only expose `catalog_state=ready` rows. Their order is
`catalog_sort_at` (the provider's update timestamp), then year and slug; an old
record discovered during backfill cannot appear as a newly updated movie merely
because it was inserted today.

PostgreSQL stores canonical metadata, provider provenance, streams, and image
source URLs only. It does not store image bytes or raw provider payloads.

### Image heal

NguonC moved its CDN from `phim.nguonc.com` (now 404) to `img.nguonc.com`, and
providers keep retaining the old URL when a fresh one is empty. Each cycle,
`healImageSources` walks NguonC list pages (checkpoint lane `image-heal`,
`IMAGE_HEAL_PAGES_PER_RUN` pages per cycle) and replaces thumb/poster source URLs
that are empty or on a dead host with the list item's current ones. Once that walk
completes it runs one pass copying another provider's stored image (e.g. KKPhim)
into movies that still have none. Set `IMAGE_HEAL_ENABLED=false` to turn it off;
delete the `crawl_checkpoints` row (nguonc / `image-heal`) to re-run.

### Image host check

Once a day (`IMAGE_HOST_CHECK_INTERVAL_MS`) the worker probes
`IMAGE_HOST_CHECK_SAMPLES` random stored image URLs of every `IMAGE_ALLOWED_HOSTS`
host (ranged GET, body discarded) and records a verdict in `image_host_health`.

- A host counts as dead only when every sample is 404/410/DNS-gone; 429/5xx/timeouts
  are inconclusive, one live sample clears it, and a simultaneous failure of all
  hosts is treated as our own network problem.
- After `IMAGE_HOST_DEAD_AFTER_CHECKS` consecutive dead checks the host leaves the
  effective allowlist (api and worker reload it every few minutes).
- Once image-heal has finished, the worker clears the dead host's links from
  `movies` (up to `IMAGE_HOST_PURGE_LIMIT` per run, skipping images still in the
  disk cache) and deletes its unreferenced `image_assets` in batches of 1000. Every
  column referencing `image_assets` needs an index, or each delete triggers
  sequential scans; see migration `022_asset_fk_indexes.sql`.
- `IMAGE_DEAD_HOSTS` is the static override. To reset a host, delete its
  `image_host_health` row.

### Image cache

The runtime image cache is a disposable SSD cache at
`/opt/stacks/blueflare/data/images`. The API mounts it read-write at
`/data/images`; the worker mounts the same path read-only, because prewarming
only needs to see which entries already exist. Existing flat cache files remain
readable; new files are sharded by hash prefix. The two image variants remain
`m` (480 x 720, q75) and `d` (1280 x 720, q75), and nothing else exists.

Public URLs are path-only and keyed by the asset row: `GET /i/{m|d}/<image_assets.id>.webp`
(built in `viewmodels.js`). The cache identity is `image_assets.id` plus variant;
requester host and frontend route never participate in the cache key. An older
HMAC-signed `?url=&sig=` form is still accepted by `images.js` for backward
compatibility and is why `IMAGE_SIGNING_SECRET` is still required, but nothing
emits it; do not build new callers on it.

Two background jobs keep that cache healthy. The worker prewarms it: after each
sync cycle it reads the same home/list viewmodels the API serves, and asks the
API over the Docker network for any referenced asset not on disk yet, so the
first visitor does not pay the upstream fetch and transcode. The API sweeps it:
hourly it removes orphan `.tmp` files and, only once the cache is over
`IMAGE_CACHE_MAX_BYTES`, evicts least-recently-read entries back under the
target. Eviction lives in the API because the API is the only writer of this
directory.

A remote storage backend for the *image cache itself* is still future work. If
one is added, keep its object keys aligned with the local cache layout,
`images/v2/{variant}/{hash-prefix}/{sha256}.webp`, and do not change the public
`img.bluesia.net/i/{m|d}/…` URL contract.

## TMDB

All TMDB passes are worker-only; no request path calls TMDB or a model. Each
needs `TMDB_API_KEY` (and `TMDB_ENABLED` for the match passes). Add every new key
to the stack `.env` as well.

### Reviews

Worker pass (`tmdbReviewsSync.js`, after the credits pass in each sync cycle).
Reviews are re-fetchable, so they are not irreplaceable state.

- Candidates: ready rows with a verified TMDB identity (`tmdb_id` + media type,
  or a `verified` cast match), oldest `reviews_checked_at` first, at most
  `TMDB_REVIEWS_LIMIT` per cycle.
- Fetch: up to 2 TMDB pages (`en-US`) per title. Reviews whose plain text is
  under 40 characters are dropped. Bodies are converted from markdown/HTML to
  plain text and truncated to 4000 characters. At most `TMDB_REVIEWS_MAX_PER_MOVIE`
  are kept. No avatars are stored.
- Refresh: a successful check (including an empty list or a TMDB 404) is
  repeated after `TMDB_REVIEWS_REFRESH_MS`. Any other failure retries after
  `TMDB_REVIEWS_RETRY_MS` and keeps the stored reviews.
- Storage: `movie_reviews` (migration `025_tmdb_reviews.sql`), plus
  `movies.reviews_checked_at` / `reviews_next_retry_at`. `score` (0-100, from
  rating, length and recency decay) and `has_spoiler` (English heuristic) are
  computed at write time.
- Order on the API: `has_spoiler` first, then 10-wide score bands, then a
  shuffle stable per slug and UTC day (`reviewOrder.js`). Spoiler reviews are
  not hidden, only flagged.
- Invalidation: changed titles drop `movie:<slug>` and
  `reviews:<slug>:{1..4}:{2,10}`; deeper pages expire on the 60s TTL.

| Variable | Meaning |
| --- | --- |
| `TMDB_REVIEWS_ENABLED` | Run the pass. |
| `TMDB_REVIEWS_LIMIT` | Titles checked per cycle. |
| `TMDB_REVIEWS_CONCURRENCY` | Parallel TMDB fetches. |
| `TMDB_REVIEWS_REFRESH_MS` | Re-check interval after a successful check. |
| `TMDB_REVIEWS_RETRY_MS` | Retry delay after a failure. |
| `TMDB_REVIEWS_MAX_PER_MOVIE` | Reviews kept per title. |

### Review translation

Separate worker-only pass (`reviewTranslateSync.js`, right after the reviews
pass in each sync cycle). It translates the English `content` to Vietnamese
through an ordered provider chain (`TRANSLATE_PROVIDER`, `translate.js`): by
default OpenRouter (see [OpenRouter rotation](#openrouter-rotation)), with the
free, unofficial Google gtx endpoint (`google-gtx`) as an optional fallback. Gemini
models, if wanted, are listed in `OPENROUTER_*_MODELS` like any other model. Only
public TMDB review text is sent to a provider. A provider can start refusing us
at any time (gtx is unofficial, free quotas run out), so everything fails open:
the API simply serves English.

- Queue: reviews of ready rows with no fresh translation (`content_vi IS NULL`
  or `translated_hash` differs from `content_hash`), skipping rows backing off
  (`translate_retry_at`), at most `TRANSLATE_REVIEWS_PER_CYCLE` per cycle. Reviews
  likely on page 1 of their title (spoiler-flagged and best score band first, the
  display order of `reviewOrder.js` without the daily shuffle) go first, then
  oldest first. Sequential, spaced
  per provider: `TRANSLATE_DELAY_MS` for gtx; OpenRouter spaces each model by its
  own RPM.
- Chunking: long text is split into chunks of at most 4000 chars on
  paragraph/sentence boundaries and rejoined keeping line breaks; transient errors
  retry twice with backoff.
- Batching (`translateBatch.js`, `TRANSLATE_BATCH_ENABLED`): several reviews go
  into one nonce-delimited OpenRouter request to save free-tier requests. The
  answer is validated and split into reviews; on a bad answer the caller splits
  the batch. A batch missing its end marker is accepted. Limits:
  `TRANSLATE_BATCH_MAX_CHARS` / `TRANSLATE_BATCH_MAX_ITEMS`.
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
- Content refusals: a `content_filter`/truncated answer, or one with stray CJK
  characters for a source without any, from one model is tried on the next model;
  when all refuse (`TranslateContentError`) it is a per-review failure that does
  NOT count toward the consecutive-error limit. Per-model state is in memory.
  Without `OPENROUTER_API_KEYS` the OpenRouter provider is skipped silently (one
  warning is logged if no provider is usable at all, so a chain with only
  `openrouter` and no key translates nothing).
- Log line: `[worker] review translate checked= ok= failed= blocked=
  providers=openrouter:N models=<model id>:A,<model id>:B keys=k1:N,k2:M`
  (`keys=` only when OpenRouter answered). `translate_provider` stores
  `openrouter:<model id>` or `google-gtx` (rows written earlier may still say
  `gemini:<model>`).
- Storage: migration `026_review_translation.sql` adds `content_vi`,
  `translated_hash`, `translated_at`, `translate_failed_at`,
  `translate_retry_at` to `movie_reviews`; migration
  `027_review_translation_provider.sql` adds `translate_provider` (internal only,
  never in the API, NULL for older rows). `content` stays the English source;
  `has_spoiler` and `score` are computed on it, not on the translation. A
  translation is only written (and served) while `translated_hash` equals the
  current `content_hash`, so a TMDB refresh that rewrites the text hides the old
  translation until it is retranslated.
- API: each review has `contentVi` (string, or `null` when there is no fresh
  translation); the contract is in `backend/ARCHITECTURE.md`. Changed titles
  are invalidated the same way as a reviews change.

| Variable | Meaning |
| --- | --- |
| `TRANSLATE_ENABLED` | Run the pass; off keeps reviews English. |
| `TRANSLATE_PROVIDER` | Ordered comma-separated chain of `openrouter`, `google-gtx`, e.g. `openrouter,google-gtx`. |
| `TRANSLATE_REVIEWS_PER_CYCLE` | Reviews translated per cycle. |
| `TRANSLATE_DELAY_MS` | gtx only: spacing between calls. |
| `TRANSLATE_TIMEOUT_MS` | gtx only: per-call timeout. |
| `TRANSLATE_MAX_CONSECUTIVE_ERRORS` | Provider-level failures in a row before the pass pauses. |
| `TRANSLATE_COOLDOWN_MS` | Pause / cooldown after a block or too many errors. |
| `TRANSLATE_BATCH_ENABLED` | Pack several reviews per OpenRouter request. |
| `TRANSLATE_BATCH_MAX_CHARS` | Characters per batch (minimum 500). |
| `TRANSLATE_BATCH_MAX_ITEMS` | Reviews per batch. |
| `OPENROUTER_TRANSLATE_MODELS` | Ordered model list, see below. |
| `OPENROUTER_TRANSLATE_PAID_DAILY_OUTPUT_TOKENS` | Paid completion-token cap per UTC day; `0` = no separate cap. |

### OpenRouter rotation

One module, `openrouter.js`, serves both review translation and the AI match. Each
job owns a separate instance (scope `translate` or `tmdb-match`, own state, own
counters, own cap). It also holds the UTC-day helpers.

- Keys: `OPENROUTER_API_KEYS` (comma list, secret) is trimmed and deduped, order
  kept. Logs name keys only as `k<n> (<first 6 hex of sha256(key)>)`; the key is
  sent only in the `authorization` header and is never logged or put into an
  error. Free-tier request limits belong to the account, so extra keys of the same
  account add nothing.
- Models: `OPENROUTER_TRANSLATE_MODELS` / `OPENROUTER_MATCH_MODELS`, ordered
  `id[:rpm[:rpd]]`, best first, free models first and paid ones later (e.g. paid
  `deepseek/deepseek-v4-flash`). A trailing `:free` is part of the id. Free models
  default to 20 rpm; paid models are not spaced; rpm 0 = no spacing.
- Status handling: 401 key off; 402 (or 403 "Key limit exceeded") model parked; any
  other 403 is a content refusal, next model; 429 daily on a `:free` model parks all
  `:free` models until 00:00 UTC, otherwise parked by `Retry-After` /
  `X-RateLimit-Reset`; 404 / "no endpoints" model off; 408/5xx transient park
  (doubles). An error body inside HTTP 200 is treated like its code.
- Paid output cap: `OPENROUTER_TRANSLATE_PAID_DAILY_OUTPUT_TOKENS` and
  `OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS` cap the completion tokens of all
  non-`:free` models together per UTC day, recorded in `ai_quota_ledger.output_tokens`
  (migration 033). At the cap paid models are blocked until the UTC reset; `:free`
  models keep serving. There is no overall token cap.
- Quota ledger (`aiQuotaLedger.js` + `aiQuotaStore.js`, table `ai_quota_ledger`,
  migration 031, renamed by 032, `output_tokens` added by 033): per key+model counts
  of requests per day (UTC days; the model's own `rpd`), per-day output-token totals
  for the paid cap, and RPM spacing from the persisted last request. A request counts
  when it starts and stays counted if it fails or times out. When OpenRouter answers
  a daily-quota 429 the count is raised to the limit (`exhaust`) even if the ledger
  thought some requests were left. Keys are stored only as a 12-hex sha256
  fingerprint. The table is disposable (see [Backup and restore](#backup-and-restore)).

| Variable | Meaning |
| --- | --- |
| `OPENROUTER_API_KEYS` | Secret, comma-separated. Empty = OpenRouter provider and the AI match off. |
| `OPENROUTER_BASE_URL` | API base. |
| `OPENROUTER_TIMEOUT_MS` | Per-request timeout for translation. |
| `OPENROUTER_COOLDOWN_MS` | How long a rejected key or unknown model stays off. |
| `OPENROUTER_TRANSLATE_MODELS` | Translation model list. |
| `OPENROUTER_MATCH_MODELS` | AI match model list. |
| `OPENROUTER_*_PAID_DAILY_OUTPUT_TOKENS` | Per-job paid cap (`TRANSLATE` / `MATCH`). |

### AI match

For ready titles with no `tmdb_id` the pass fetches real TMDB candidates
(`tmdbMatchAi.js`), has an OpenRouter model rank them, and lets an independent gate
decide. The model never supplies an id, only picks among fetched candidates. It
runs only with `TMDB_MATCH_AI_ENABLED=true`, an `OPENROUTER_API_KEYS` key,
`TMDB_MATCH_AI_MODE` other than `off`, and `TMDB_ENABLED` plus a TMDB key.

- Gate (`decideAiMatch`, pure): the model's pick is `verified` only if tier 1 holds
  (catalog cast >= 2 and >= 2 names overlap the candidate's cast, year and size
  compatible; TV season not above the candidate's season count) or tier 2 holds
  (exact name + year + size, no other candidate passes the same test; a row
  without a year is refused). Otherwise `unverifiable` (a pick the gate refused) or
  `none` (no candidates, no pick). Every verdict is recorded in
  `tmdb_match_ai_runs` (`status` + `outcome`, migration 029).
- Dry-run vs apply: `dry-run` (default) only writes `tmdb_match_ai_runs`. `apply`
  also calls `assignTmdbIdentity` (source `inferred`) for verified picks: it writes
  the id on the row or merges it into the row already holding that identity.
  Independent of `TMDB_IDENTITY_MODE`, which only governs promotion of the
  cast-verified `tmdb_match_*` rows. In apply mode a title whose last run was a
  dry-run `verified` is examined again.
- Retry windows: `none`, `unverifiable` and verified-but-not-applied results are
  not re-examined for `TMDB_MATCH_AI_RETRY_MS`; errors wait
  `TMDB_MATCH_AI_ERROR_RETRY_MS`. Rows with a cast of two or more go first.
- Loop: `tmdbMatchAiLoop.js` wakes every `TMDB_MATCH_AI_LOOP_MS` and ranks one
  token-packed batch per tick; `TMDB_MATCH_AI_LOOP=false` runs the older whole pass
  inside the sync cycle instead (`TMDB_MATCH_AI_LIMIT` titles per cycle). The scope
  `priority` (films first seen within `TMDB_MATCH_AI_FRESH_MS`, and films whose last
  run errored) runs first; the old backlog (`all`) runs once `priority` is empty.
- Batching: films are packed into one request until `TMDB_MATCH_AI_BATCH_TOKENS`
  (estimated chars/3 and corrected from the prompt token count each response
  reports) or `TMDB_MATCH_AI_BATCH_MAX` is reached; a batch holds one tier only. A
  request the model refuses is bisected until the offending film is alone (then
  `model-refused`).
- Log lines: `[worker] tmdb ai match mode= scope= requests= checked= verified=
  unverifiable= none= error= merged= assigned= tokens=prompt/output/thoughts
  models=`; the loop logs state changes only (`[worker] tmdb ai match loop:
  blocked|idle`); warnings `tmdb ai match batch failed`, `... assign failed
  for <slug>`, `... could not record run`, `[worker] ai quota ledger save
  failed|could not load`. Promotion logs `[worker] tmdb identity promote checked=
  assigned= merged= blocked= conflict=`.
- Development scripts (read-only against the catalog, they hit TMDB and
  OpenRouter): `scripts/tmdb-ai-backtest.mjs` (precision against provider-supplied
  ids), `tmdb-ai-classify.mjs` (breakdown of rows still without identity),
  `tmdb-ai-dryrun.mjs` (dry run of the pass on real rows).

| Variable | Meaning |
| --- | --- |
| `TMDB_MATCH_AI_ENABLED` | Master switch. |
| `TMDB_MATCH_AI_MODE` | `off` / `dry-run` / `apply`. |
| `TMDB_MATCH_AI_LOOP` | Own worker loop; `false` folds the pass into the sync cycle. |
| `TMDB_MATCH_AI_LOOP_MS` | Loop wake interval (minimum 5000). |
| `TMDB_MATCH_AI_WORKED_MS` | Pause between batches while a backlog remains (loop only). |
| `TMDB_MATCH_AI_LIMIT` | Titles per cycle (only when the loop is off). |
| `TMDB_MATCH_AI_RETRY_MS` | Re-examine delay for none / unverifiable / not applied. |
| `TMDB_MATCH_AI_ERROR_RETRY_MS` | Re-examine delay after an error. |
| `TMDB_MATCH_AI_FRESH_MS` | "Recently first seen" window for the `priority` scope. |
| `TMDB_MATCH_AI_BATCH_TOKENS` | Estimated prompt tokens per batch. |
| `TMDB_MATCH_AI_BATCH_MAX` | Films per batch. |
| `TMDB_MATCH_AI_THINK_T1` | Reasoning tokens for films with a cast; `0` = off. |
| `TMDB_MATCH_AI_THINK_T2` | Reasoning tokens for films without a cast. |
| `TMDB_MATCH_AI_TIMEOUT_MS` | Per-request timeout. |
| `TMDB_MATCH_AI_TRANSIENT_PARK_MS` | Park time after a 5xx / timeout; doubles on repeats. |
| `TMDB_MATCH_AI_TRANSIENT_PARK_MAX_MS` | Upper bound of that doubling. |
| `OPENROUTER_MATCH_MODELS` / `OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS` | Model list and paid output cap. |

### Identity audit and undo

Every assign, merge, blocked and conflict is a row in `tmdb_identity_changes`
(migration 030; merges point at the `movie_merges` snapshot).

- `node scripts/tmdb-identity-report.mjs <out.csv> [--n 200] [--seed 1] [--tmdb]`
  is the read-only review sample.
- `node scripts/tmdb-identity-undo.mjs <changeId>` reverses one assign or merge
  (it refuses if the identity changed since) and prints the result. It writes to
  the database only, so the affected slugs must be invalidated afterwards (Valkey
  keys and Next render tags, as the worker does after a sync) or readers keep the
  old page.

## Duplicate merge (NguonC + KKPhim)

`MERGE_DUPLICATES_MODE=dry-run` logs `pairs=`/`ambiguous=` each sync cycle; `apply` merges up to
`MERGE_BATCH_LIMIT` pairs per cycle. A pair needs equal normalized original title, year and media
type, a compatible season, episode totals within 1.5x, agreeing slug bases, and must be one-to-one.
Undo one merge by hand from `movie_merges` (`dropped_row`, `moved_source_ids`, `favorites`, `history`);
delete the matching `movie_slug_aliases` row. `tools/merge-backtest.mjs` is the read-only precision
check, `tools/merge-duplicates.mjs --apply` runs the merge against a scratch `DATABASE_URL`.

## API contract

| Endpoint | Notes |
| --- | --- |
| `GET /api/health` | Also served at `/healthz`. |
| `GET /api/home-data` | |
| `GET /api/list?type=phim-le&page=1` | |
| `GET /api/genre?slug=chinh-kich&page=1` | |
| `GET /api/country?slug=trung-quoc&page=1` | |
| `GET /api/search?keyword=ren%20yu&page=1` | |
| `GET /api/movie/:canonicalSlug` | |
| `GET /api/recommendations/:canonicalSlug` | |
| `GET /api/person/:slug?role=&page=` | Cast/director credits. |
| `GET /api/movies/:canonicalSlug/reviews?page=1&limit=10` | Public, cached 60s; contract in `backend/ARCHITECTURE.md` (`contentVi` null when untranslated; limit default 10, max 20; 404 for unknown slug). |
| `GET /api/categories` | |
| `GET /api/countries` | |
| `GET /api/cards?slugs=a,b` | Public, cached 60s, key = sorted slug list. |
| `/api/auth/*`, `/api/me/*` | Accounts, sessions, favorites, history with last episode. Never cached; reachable only via the Next proxy, 404 on img.bluesia.net; 429 `rate_limited` / 503 `busy` with `Retry-After`. |
| `GET /i/{m\|d}/<image_assets.id>.webp` | Path-only image URL, see [Image cache](#image-cache). |

Only image variants `m` (480 x 720) and `d` (1280 x 720) exist.

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

## Operations

### Runtime/codebase split

Decision (2026-08-18, ADR-001, since folded in here): the Docker stack directory holds
runtime only, and the source lives elsewhere.

- **Codebase** `/home/ubuntu/blueflare`: full git clone, the only source of the Dockerfiles,
  `src/`, `backend/src/` and migrations.
- **Runtime** `/opt/stacks/blueflare` (path chosen so dockhand finds the stack): `compose.yml`,
  `.env` (chmod 600, secrets, never in git), `deploy/`, `data/images/` (the bind-mounted image
  cache) and `backups/`.
- Compose builds from the codebase through `BLUEFLARE_SRC` (build context
  `${BLUEFLARE_SRC}/backend`, frontend `${BLUEFLARE_SRC}` with `Dockerfile.frontend`), so no
  registry or CI is needed. `infra/compose.yml` in the repo is the source of truth;
  `infra/scripts/sync-stack.sh` copies it to the stack directory.
- Keep `name: blueflare` in compose. Renaming the project makes Compose create new volumes
  and the Postgres data would appear lost.
- Rejected alternatives: pushing images to a registry (needs CI and a build/push/pull loop
  before every deploy, worth it only with a second host) and merely cleaning junk out of the
  old combined directory (leaves secrets next to the git tree).
- Consequence: deploys touch two places (`git pull` in the codebase, then build and recreate
  from the stack directory, which `scripts/deploy.sh` does). The stack cannot rebuild itself
  without the codebase, which is acceptable because it is one `git clone` away. What cannot
  be cloned (Postgres volume, image cache, `.env`) sits in the stack directory, which is what
  gets backed up.

### Verification

Tests run from the repository, not the stack directory: `cd backend && node --test`
(see Verification in `/CLAUDE.md` for the full checklist). Representative provider
response fixtures are under `backend/test/fixtures`. Against the running stack:

    cd /opt/stacks/blueflare
    docker compose --env-file .env -f compose.yml logs --tail=100 worker
    curl -fsS http://127.0.0.1:3200/api/home-data
    curl -fsS 'http://127.0.0.1:3200/api/list?type=phim-le&page=1'

Provider documentation verified during implementation:

- NguonC: https://phim.nguonc.com/api-document
- KKPhim: https://kkphim.com/api-document

### Backup and restore

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
The TMDB identity audit/undo log `tmdb_identity_changes` (migration `030`) is in the dump too.
`ai_quota_ledger` (migrations `031`/`032`, `output_tokens` from `033`) is disposable: after a
restore without it the ledger counts from zero until the provider answers 429.

For a backup outside the schedule:

    /opt/stacks/blueflare/deploy/backup-postgres.sh

(`infra/scripts/backup-postgres.sh` in the repo, synced there by `sync-stack.sh`.)

### Rebuilding this VPS from nothing

The repository carries everything except secrets and data:

1. Clone the repository and run `infra/scripts/bootstrap-vps.sh`. It regenerates
   `POSTGRES_PASSWORD`, `IMAGE_SIGNING_SECRET`, `FRONTEND_REVALIDATE_SECRET`
   and `METRICS_TOKEN`. `TMDB_API_KEY` (like the OpenRouter key list) cannot be regenerated,
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

### Caddy

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

Caddy obtains and serves the origin certificate for img.bluesia.net. Once the
route is active, Cloudflare Full (strict) can reach the origin without 525. The
Caddy admin API can load a route immediately, but that does not replace the
privileged `/etc/caddy/Caddyfile` edit: persist the site block before the next
Caddy restart.

#### Image site: img.bluesia.net

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

#### Next.js frontend: phim.bluesia.net

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

The `@authdirect` rule (403 for `/api/auth/*` unless the peer is a Cloudflare
address) also lives in this block: see `infra/CLOUDFLARE.md`.

Format, validate, and reload Caddy using the same host procedure as the image
site. Verify after reload:

    curl -fsSI https://phim.bluesia.net/
    curl -fsSI 'https://phim.bluesia.net/list/phim-le?page=2'
    curl -fsSI https://phim.bluesia.net/movie/example-slug
    curl -fsS https://phim.bluesia.net/healthz

### Cloudflare cache rule

`/i/` images are extension-based assets (`.webp`, path-only URLs) and use a
one-year immutable origin header. Two zone Cache Rules are kept in
`infra/cloudflare/`; neither applies to video/embed URLs.

- `cloudflare-image-cache-rule.json`: `img.bluesia.net` GET/HEAD under `/i/`,
  one-year edge and browser TTL, overriding the origin.
- `cloudflare-cache-rule.json`: an allowlist for the extensionless JSON
  endpoints on `img.bluesia.net` (GET/HEAD), 5 minutes at the edge and 60 s in the
  browser (overriding the origin TTL). It covers exactly `/api/home-data`,
  `/api/list`, `/api/genre`, `/api/country`, `/api/categories`, `/api/countries`,
  `/api/movie/*` and `/api/recommendations/*`. It does not cover
`/api/movies/*/reviews`, `/api/person/*`, `/api/cards`, `/api/search` or
`/api/health`; those are not edge-cached (the API's own Valkey cache still applies).
Rules are applied by hand: re-apply the JSON in Cloudflare after changing it.

Verify edge behavior with two identical requests:

    curl -sSI https://img.bluesia.net/api/home-data | grep -iE 'cf-cache-status|age|cache-control'
    curl -sSI https://img.bluesia.net/api/home-data | grep -iE 'cf-cache-status|age|cache-control'

The second response should report `CF-Cache-Status: HIT`. A `DYNAMIC` result
means the Cache Rule is not active or the token used to create it lacks
`Zone > Cache Rules > Edit`.

### PostgreSQL container upgrades

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

### Valkey upgrades

Valkey is a rebuildable response cache, but AOF is retained for stale-response
availability. The Compose default caps it at `512mb` so `allkeys-lru` has an
effective bound. Upgrade Valkey separately from PostgreSQL, verify AOF load,
`PING`, key count and API cache hit/miss behavior, then observe logs and memory
for at least 15 minutes. If the existing AOF cannot be loaded, start Valkey on
an empty cache volume; the API will repopulate it from PostgreSQL.

### Host sysctl for Valkey

`vm.overcommit_memory` is a host-level kernel setting and cannot be applied through this container's Compose namespace. On the Docker host, run as root:

    sysctl -w vm.overcommit_memory=1
    printf '%s\n' 'vm.overcommit_memory=1' > /etc/sysctl.d/99-blueflare-valkey.conf
    sysctl --system

Verify with `sysctl vm.overcommit_memory` returning `1`, then restart Valkey once if the warning was emitted during startup.

### PgBouncer decision

PgBouncer is intentionally not part of this stack. The API and worker each use one `pg.Pool` capped at 12 connections, while the current PostgreSQL runtime has a limit of 100 and only a few active clients. Transaction pooling would also conflict with the migration's session-level advisory lock. Reconsider it only after measured connection pressure or additional API/worker replicas; any future transaction-pooled deployment must keep migrations on a direct PostgreSQL connection or use transaction-scoped advisory locking.
