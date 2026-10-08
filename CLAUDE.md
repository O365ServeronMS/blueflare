# FilmBluesia — engineering guide

This file is the single authoritative description of how the project is built and
run. The other documents are narrower specs (see the documentation map); where they
disagree, this file wins.

Contents: [Architecture](#architecture) · [The running stack](#the-running-stack) ·
[Background jobs](#background-jobs) · [Commands](#commands) · [Source map](#source-map) ·
[Invariants](#invariants) · [Playback and loading](#playback-and-loading) ·
[Backup and recovery](#backup-and-recovery) · [Verification](#verification) ·
[Documentation map](#documentation-map)

## Architecture

FilmBluesia (`phim.bluesia.net`) is a Next.js 16 + React 19 App Router application rendered by a Node 26 standalone container on the VPS. Caddy terminates the public site and reverse-proxies to `127.0.0.1:3100`; Cloudflare is only the normal DNS/TLS/proxy/CDN layer. There is no Astro, frontend Worker, Pages Function, SSR edge runtime, or static-host rewrite.

The repository also owns `backend/`: API, provider sync worker, PostgreSQL, Valkey, and the image cache behind `img.bluesia.net`. Server Components call the API through the Docker network (`INTERNAL_CATALOG_URL`); browser components own playback. Favorites/history stay in browser `localStorage` for guests and sync to the account when signed in; the last watched episode per movie lives on the history row in PostgreSQL for signed-in users. NguonC is primary metadata, KKPhim fills gaps and alternate streams. Video bytes are never proxied.

## The running stack

Seven compose services. Two of them are *supposed* to sit at `Exited (0)` — that is
their designed finished state, not a failure:

| Service | Role |
| --- | --- |
| `frontend` | `frontend/src/server/cluster.mjs`: balancer on :3000 in front of `FRONTEND_WORKERS` (3) Next standalone workers, published on `127.0.0.1:3100` |
| `api` | catalog API + image cache origin, `127.0.0.1:3200` |
| `worker` | provider sync loop, hero-trending refresh, image prewarm |
| `postgres` | canonical metadata, volume `postgres-data` |
| `valkey` | JSON response cache, `allkeys-lru`, capped |
| `image-cache-init` | one-shot `mkdir`+`chown` of the image cache dir, then `Exited (0)` |
| `backup` | scheduled offsite dump (optional, `BACKUP_ENABLED`, default `false` in `.env.example`); `Exited (0)` when `BACKUP_ENABLED=false` |

Host-side container names are pinned to `blueflare-<service>` without Compose's
replica suffix. Service-to-service traffic still uses the stable service DNS names
(`frontend`, `api`, `postgres`, and `valkey`), never the host-side container names.

`api` gates on `image-cache-init` completing successfully, because it runs as uid
1000 and would otherwise fail to write a root-owned bind mount.

## Background jobs

Four loops run outside the request path. None of them may be moved into the request path.

### Provider sync

`worker`, every `SYNC_INTERVAL_MS`. One cycle does, in order:

- **Crawl and backfill:** crawls NguonC/KKPhim head pages plus a checkpointed backfill and upserts canonical rows.
- **Ratings:** enriches approved visible rows with MDBList Rotten Tomatoes critic/audience scores under a per-key daily budget.
- **TMDB recommendations and credits:** refreshes TMDB recommendation/similar id lists for the detail-page rail, and TMDB cast/director credits for rows with a verified TMDB identity.
- **Reviews:** refreshes TMDB user reviews (`TMDB_REVIEWS_*`, table `movie_reviews`, verified identity only; the worker is the only caller, never a request path) and stores them as plain text. Reviews are re-fetchable from TMDB, not irreplaceable state.
- **Translation:** a separate worker-only pass right after the reviews pass machine-translates stored English reviews to Vietnamese (`TRANSLATE_*`, columns `content_vi`/`translated_hash` on `movie_reviews`). It is sequential and never a request path; only public TMDB review text is sent; column `translate_provider` = `openrouter:<model>`/`google-gtx`.
  - Ordered provider chain `TRANSLATE_PROVIDER`, default OpenRouter (`OPENROUTER_API_KEYS`, ordered `OPENROUTER_TRANSLATE_MODELS`, free models first and paid ones later), with the free unofficial Google gtx endpoint as an optional fallback. Gemini models are reached only through OpenRouter, by listing them in `OPENROUTER_*_MODELS`.
  - Paid cap: `OPENROUTER_TRANSLATE_PAID_DAILY_OUTPUT_TOKENS` / `OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS` cap the completion tokens of all non-`:free` models together per UTC day (column `output_tokens` of `ai_quota_ledger`, 033); `:free` models keep serving after it. There is deliberately no total daily token cap (`OPENROUTER_*_DAILY_TOKENS` were removed on purpose; do not reintroduce them).
  - Batching: `TRANSLATE_BATCH_ENABLED` (default `false`) packs several reviews into one nonce-delimited request, validated and split on a bad answer (`translateBatch.js`).
- **Duplicate merge:** `reconcileDuplicates` (`MERGE_DUPLICATES_MODE=off|dry-run|apply`, default `apply` in `config.js` and `.env.example`; `MERGE_BATCH_LIMIT`) runs inside the same cycle, before invalidation, and folds a NguonC-only row into the KKPhim-only row of the same work (`backend/src/duplicateMerge.js` plans, `duplicateMergeRepository.js` applies in one transaction). The KKPhim row survives; the dropped canonical slug is kept in `movie_slug_aliases` and `findMovie`/`listReadyBySlugs` resolve it; `movie_merges` snapshots the dropped row and its moved user rows for manual undo.
- **TMDB identity chain:** separate from the AI match below. `TMDB_MATCH_ENABLED` runs the deterministic cast-verified match (`tmdbMatch.js`, writes `tmdb_match_*` only), and `promoteVerifiedMatches` (`TMDB_IDENTITY_MODE=off|dry-run|apply`, default `off`) turns those verified rows into a real `tmdb_id` through `tmdbIdentity.js`.
- **Cache invalidation:** last, invalidates Valkey keys and Next render tags for exactly what changed (reviews: the `movie:<slug>` tag plus `reviews:<slug>:*` keys).

### TMDB AI match

`worker`, its own loop every `TMDB_MATCH_AI_LOOP_MS` (`tmdbMatchAiLoop.js`; `TMDB_MATCH_AI_LOOP=false` folds it back into the sync cycle). For titles without a `tmdb_id`, it fetches real TMDB candidates and has an OpenRouter model rank them, when `TMDB_MATCH_AI_ENABLED=true`, using `OPENROUTER_API_KEYS` and the ordered `OPENROUTER_MATCH_MODELS` (empty key = pass off; translation and match keep separate ledger scopes and separate paid output caps). Never a request path.

- The model never supplies an id; an independent two-tier gate (`decideAiMatch`: T1 cast overlap + year, T2 exact name + year + size, no rival candidate) decides.
- `TMDB_MATCH_AI_MODE=off|dry-run|apply`, default `dry-run` (verified in `backend/src/config.js`): dry-run only writes `tmdb_match_ai_runs`; apply writes `tmdb_id` with source `inferred` through `tmdbIdentity.js` (assign, or merge into the row already holding it).
- Every assign/merge/blocked/conflict is logged in `tmdb_identity_changes` (030) and reversible with `backend/scripts/tmdb-identity-undo.mjs`.
- Films are packed into token-budget batches. Quota is tracked per key+model per UTC day in `ai_quota_ledger` (031, renamed by 032; disposable).

### Image prewarm

`worker`, end of every sync cycle: reads the same home/list viewmodels the API serves, extracts the asset URLs the next visitor will request, and asks the API to build any that are missing. It never writes the cache itself — it mounts `/data/images` **read-only** and only uses it to skip entries that already exist.

### Image cache sweep

`api`, hourly: removes orphan `.tmp` files, and once the cache exceeds `IMAGE_CACHE_MAX_BYTES`, evicts least-recently-read entries back under target. Lives in `api` because **`api` is the only writer of `/data/images`** — keep it that way.

## Commands

Frontend commands run from `frontend/` (or `npm --prefix frontend <cmd>`).

| Command | What it does |
| --- | --- |
| `npm run dev` | Next dev server on http://localhost:3000 |
| `npm run build` | production Next build |
| `npm run start` | `.next/standalone/server.js` |
| `npm run preview` | serve the standalone build |
| `npm test` | vitest, frontend |
| `cd backend && node --test` | backend suite |
| `scripts/deploy.sh [--dry-run] [svc...\|all]` | build changed services, recreate, health gate, auto-rollback |
| `scripts/rollback.sh [--dry-run] [svc...]` | swap services back to their previous (`:prev`) images |

`scripts/deploy.sh` ships only a clean, pushed `main`, records the running rev in
`/opt/stacks/blueflare/.last-deploy`, and tags each replaced image `:prev`. A
rollback moves images only; it does not undo migrations or synced stack files.

Codebase and runtime are separate directories (`backend/README.md`, "Runtime/codebase split"): the repo lives at `/home/ubuntu/blueflare`, while the Docker stack runs from `/opt/stacks/blueflare` (`compose.yml`, `.env`, `deploy/`, `data/images/`, `backups/`). `infra/compose.yml` and `deploy/*` in this repo are the source of truth; `infra/scripts/sync-stack.sh` copies them to the stack directory. Compose builds straight from the codebase through `BLUEFLARE_SRC`. Do not run a production restart, a sync, or a Caddy reload unless explicitly requested.

## Source map

### Frontend

`frontend/` holds the whole Next.js app; paths are relative to it unless prefixed.

| Path | Role |
| --- | --- |
| `src/app/` | App Router pages incl. `api/auth/*` and `api/me/*` (same-origin account proxy): `/`, `/list/[type]`, `/search`, `/movie/[slug]`, `/person/[slug]`, `/login`, `/signup`, local libraries, `/healthz`, internal revalidation |
| `src/styles/globals.css` | shared design tokens and Tailwind styles; accent is red `#e4312a` |
| `components/` | shared React UI, navigation, cards, `CastStrip.tsx`, pagination, playback |
| `components/AuthForm`, `LastWatchedBadge`, `useAccount` | account UI and hook |
| `components/ReviewsSection.tsx` (server, detail page) + `ReviewList.tsx` (client, "Xem thêm") | reviews UI |
| `components/AdminDashboard.tsx` | `/admin` dashboard |
| `lib/catalog.ts` | browser-safe catalog client |
| `lib/catalog-server.ts` | cached server API helpers |
| `lib/navigation.ts` | returnTo/page URL contracts |
| `lib/playback.ts` | device/source ordering; keep it centralized |
| `lib/account-proxy.ts` | same-origin proxy to the API (`bf_session` cookie, Origin check, real client IP, hardcoded Cloudflare IP ranges) |
| `lib/movie-sync.ts`, `lib/movie-store.ts` | favorites/history sync incl. last watched episode |
| `lib/reviews.ts` | reviews client helpers |

The Cloudflare IP ranges in `lib/account-proxy.ts` are hardcoded; refresh them from cloudflare.com/ips when they change. Stale ranges only make the proxy fall back to the peer address.

### Backend

`backend/src/`:

| File(s) | Role |
| --- | --- |
| `server.js` | API + sweep scheduler |
| `worker.js` | sync + rating enrichment + prewarm |
| `mdblist.js`, `mdblistRatingsSync.js` | batched Rotten Tomatoes scores |
| `images.js`, `imageStore.js` | image cache origin |
| `prewarm.js`, `imageCacheSweep.js`, `concurrency.js` | prewarm, sweep, concurrency helpers |
| `repository.js`, `viewmodels.js`, `cache.js` | data access, API view models, Valkey cache |
| `recommendations.js` | TMDB recommendation/similar rail |
| `people.js` | cast/director slug + identity |
| `tmdbReviews.js`, `tmdbReviewsSync.js` | plain-text normalising, score, spoiler flag; worker pass |
| `reviewSpoiler.js`, `reviewOrder.js` | spoiler detection; display order + cache keys |
| `translate.js`, `openrouter.js`, `reviewTranslateSync.js` | chunking + OpenRouter and gtx providers + provider chain; OpenRouter key/model rotation, status handling, paid-output cap, UTC-day helpers (used by translation and the TMDB AI match); worker translation pass |
| `translateBatch.js` | batched translation requests |
| `tmdbMatch.js` | cast-verified match |
| `tmdbMatchAi.js`, `tmdbMatchRotation.js`, `tmdbMatchAiSync.js`, `tmdbMatchAiLoop.js` | AI match: candidates, prompt, two-tier gate; rotation; pass engine (`tmdb_match_ai_runs`); fourth worker loop |
| `tmdbIdentity.js` | assign/merge/promote/undo of TMDB identity (`tmdb_identity_changes`); `backend/scripts/tmdb-identity-report.mjs` read-only review CSV, `tmdb-identity-undo.mjs <changeId>` |
| `duplicateMerge.js`, `duplicateMergeRepository.js` | duplicate merge plan / apply |
| `aiQuotaLedger.js`, `aiQuotaStore.js` | per key+model daily quota in `ai_quota_ledger` |
| `auth.js` | password hashing + sessions + `HashGate` scrypt concurrency cap |
| `authLimits.js` | auth rate-limit counters: Valkey with in-memory fallback |
| `turnstile.js` | Cloudflare Turnstile siteverify |
| `meApi.js`, `meRepository.js` | `/api/auth/*` + `/api/me/*` handler (never cached) and its repository |

### Infra

| Path | Role |
| --- | --- |
| `infra/compose.yml` | canonical compose file |
| `infra/cloudflare/` | rules; `cloudflare-auth-ratelimit-rule.json` is applied by hand |
| `infra/backup/` | backup service image |
| `infra/scripts/` | `sync-stack.sh`, `apply-env.sh`, `backup-postgres.sh`, `bootstrap-vps.sh` |

The two Caddy site blocks live inline in `bootstrap-vps.sh`, not as separate files.

## Invariants

### Data and navigation

- Catalog data comes only from the repository-owned Blueflare API. Server fetches use the Docker hostname; never add provider calls to a request path.
- Public list/search/detail routes must preserve query parameters. `returnTo=<encoded path+search>` is the only new movie category-context mechanism; do not add hash fragments.
- Pagination is the compact Netflix-style window defined in `frontend/PAGINATION.md`; page links must retain type and filters.

### Images

- Images are served as exactly two variants: `/i/m/` portrait (480x720) and `/i/d/` landscape (1280x720). Live URLs are **path-only and keyed by `image_assets.id`** (`/i/{m,d}/<uuid>.webp`). An older HMAC-signed `?url=&sig=` form still exists in `images.js` for backward compatibility, but nothing emits it — do not build new callers on it, and never create a third variant.
- `/data/images` has exactly one writer: the `api` service. Anything else that needs it mounts read-only.

### Accounts and auth

- Account routes (`/api/auth/*`, `/api/me/*`) are per-user and uncached (no `getOrBuild`, no response caching; the only Valkey use is the auth rate-limit counters `auth:rl:*`, sha256 keys, fail-open to in-memory counters).
- Reachable only through the Next proxy on `phim.bluesia.net`; `img.bluesia.net` returns 404 for them via a Caddy rule in `bootstrap-vps.sh` (an already-deployed Caddyfile must be edited by hand: `inject_caddy_block` skips existing blocks).
- `/api/auth/*` on `phim.bluesia.net` is refused with 403 by the `@authdirect` Caddy rule unless the peer is in the Cloudflare ranges (must match `CLOUDFLARE_RANGES` in `lib/account-proxy.ts`; an already-deployed Caddyfile must be edited by hand). A Cloudflare rate-limit rule (`infra/cloudflare/cloudflare-auth-ratelimit-rule.json`) is applied by hand.
- Session cookie `bf_session` is HttpOnly, SameSite=Lax.
- The API answers 429 + `Retry-After` when rate-limited and 503 `{error:"busy"}` + `Retry-After: 2` when the scrypt gate is full; login failures lock out with 429 instead of sleeping.
- Signup also verifies a Cloudflare Turnstile token (`backend/src/turnstile.js`, siteverify; body field `turnstileToken`) when `TURNSTILE_SECRET_KEY` is set on `api`; empty secret disables it. The public `TURNSTILE_SITE_KEY` is read by the signup page at runtime. Failure is 400 `captcha_failed`, siteverify outage is 503 `busy`.
- The admin dashboard (`/admin`, `components/AdminDashboard.tsx`) talks to `/api/me/admin/users[/<uuid>[/sessions]]` through the same proxy allow-list; access is a session whose email is in `ADMIN_EMAILS` (api env, also in stack `.env`), everything else gets 404. Admin accounts cannot be deleted through it, because registration is unverified and a freed admin email could be claimed by anyone.
- `GET /api/cards?slugs=` is public, cached 60s, keyed by the sorted slug list only.
- scrypt shares the libuv threadpool with image I/O and sharp, so `AUTH_HASH_CONCURRENCY` (2) must stay well below `UV_THREADPOOL_SIZE` (8, set on `api` in `infra/compose.yml`). `AUTH_HASH_QUEUE` and `AUTH_REGISTER_GLOBAL_PER_HOUR` live in `backend/.env.example` and must also be in the stack `.env`.

### Reviews and translation

- `GET /api/movies/:slug/reviews` is public and cached 60s, keyed `reviews:<slug>:<page>:<limit>` only (never cookies, user agent or `returnTo`); the browser "Xem thêm" button calls it on `img.bluesia.net` like other client catalog calls. Page 1 (2 reviews) rides along in `GET /api/movie/:slug`.
- Each review carries `contentVi` (null unless a translation of the current English text exists).
- A provider can be blocked at any time (gtx is unofficial); it then goes into its own cooldown (`TRANSLATE_COOLDOWN_MS` / `OPENROUTER_COOLDOWN_MS`), the next provider in the chain continues the same review, and the API fails open to English when none is left.
- `hasSpoiler` and `score` are computed on the English text, never on the translation.

### Caching and revalidation

- Next render-cache tags and Valkey/API cache keys must not vary by `returnTo`, cookies, authorization, user agent, or analytics parameters.
- The frontend runs several Next processes and Next's `"use cache"` store is per process, so `cluster.mjs` replays every `/api/internal/revalidate` POST to all workers and answers 2xx only if all did (503 while one restarts). Never point the sync worker at a single worker port, and keep `FRONTEND_WORKERS`, `cpus` and the per-worker `--max-old-space-size` inside the container `mem_limit`.
- `/api/internal/revalidate` is POST-only, secret-protected, and not public through Caddy. The worker sends deduplicated tags in sequential batches of at most 32; the route hard-expires each tag so changed detail data cannot remain stale.

## Playback and loading

- Desktop/Android prefer iframe/embed; iOS prefers native HLS. MSE fallback dynamically imports only `hls.js/dist/hls.light.js`.
- Never mount an embed iframe or autoplay media before an explicit Play action.
- The first visible home hero is the only eager/high-priority image. Other posters/backdrops are lazy and preserve aspect ratio.
- Keep client boundaries small; prefer Server Components and parallel data fetching.

## Backup and recovery

PostgreSQL is the only irreplaceable state, including user accounts, sessions and
per-title watch history with the last episode (migrations 020, 021) and the TMDB identity audit/undo log `tmdb_identity_changes` (030), all covered by the same dump. `ai_quota_ledger` (031, renamed by 032) is disposable: wiping it only resets the day's request count until the provider answers 429. The image cache rebuilds itself from
`image_assets`; Valkey is disposable; the frontend is stateless.

The `backup` service dumps, verifies with `pg_restore --list`, uploads to an
S3-compatible store and prunes both ends. It is optional: it only runs when
`BACKUP_ENABLED=true` (the `.env.example` default is `false`), then every
`BACKUP_INTERVAL_SECONDS` (86400 = daily). The target is generic on purpose —
changing provider is an env change (`BACKUP_S3_*`), not a code change. The full
rebuild-from-nothing runbook is in `backend/README.md`.

Third-party credentials such as `TMDB_API_KEY`, `MDBLIST_API_KEY`, `OPENROUTER_API_KEYS`, and
`MDBLIST_API_KEYS` cannot be regenerated by `infra/scripts/bootstrap-vps.sh`; keep a
secure copy off the machine.

## Verification

`scripts/verify.sh` runs the whole checklist and exits non-zero if anything failed
(`--changed` limits it to the sections the working tree touches). The local
`verifier` agent (`.claude/`, not in the repo) runs it and reports only failures.
What it runs:

| Check | What | When |
| --- | --- | --- |
| `whitespace` | `git diff --check HEAD` | always |
| `backend` | `cd backend && node --test` (fails if `backend/node_modules` is missing) | `backend/` changed |
| `vitest-scope` | every frontend test file is inside a `vitest.config.ts` include glob | `frontend/` changed |
| `vitest` | `cd frontend && npx vitest run` | `frontend/` changed |
| `build` | `cd frontend && npm run build` | `frontend/` changed |
| `compose` | `docker compose -f infra/compose.yml config --quiet` with `BLUEFLARE_ENV_FILE=$PWD/backend/.env.example (absolute path)` | `infra/` or `.env.example` changed |
| `shell` | `bash -n` on `scripts/*.sh`, `scripts/lib/*.sh`, `infra/scripts/*.sh`, `infra/backup/*.sh` | a shell script changed |
| `env-keys` | every key of `backend/.env.example` exists in the stack `.env` | `.env.example` changed |
| `smoke` | against the running containers: `/healthz`, `/list/phim-le?page=2`, `/list/phim-le?page=3`, a non-existent `/person/<slug>` (404 ok, 5xx fails), `/api/movie/<slug>` and `/movie/<slug>` for a live slug, and `/person/<slug>` for a real cast member when credits exist | always |
| `revalidate` | unauthenticated POST to `/api/internal/revalidate` must answer 401/403/404 | always |
| `api-health` | `/api/health` status and worker; a warning only, not a failure | always |

Production checks are separate and read-only. The local `prod-tester` agent (`quick` after each
deploy, `full` adds the security probe and background-job review) writes its report under
`~/.claude/reports/blueflare/`. The local `prod-stress-tester` agent drives
`scripts/stress/stress-run.sh` (`cdn`, `origin`, `soak <conc>`; GET only, max 40 concurrent,
aborts on host/health guardrails) and runs only when the user asks.

Run `npm run build` and `npm test` (in `frontend/`) for frontend changes, and `(cd backend && node --test)` for backend changes. Validate the compose file with
`BLUEFLARE_ENV_FILE=$PWD/backend/.env.example docker compose -f infra/compose.yml config --quiet`
(the absolute `BLUEFLARE_ENV_FILE` is required because the real `.env` only exists in the stack directory), and a container smoke test for `/healthz`, `/list/phim-le?page=2`, `/list/phim-le?page=3`, and protected revalidation. Run `git diff --check HEAD`.

`backend/node_modules` is installed on the host, so `node --test` must be fully
green. If `providers.test.js` fails with `Cannot find package 'pg'`, the directory
is gone — run `npm ci` in `backend/`; do not skip or delete the test.

When adding a key to `backend/.env.example`, add it to the stack `.env` too —
`infra/scripts/apply-env.sh` fails the deploy if `.env` is missing anything the example
documents.

## Documentation map

| File | Status | Owns |
| --- | --- | --- |
| `CLAUDE.md` (this file) | live | architecture and invariants; start here, wins on any conflict |
| `backend/README.md` | live | backend internals, runtime/codebase split, backup/restore runbook, PostgreSQL major upgrades, Caddy |
| `backend/ARCHITECTURE.md` | live | backend architecture, cache, accounts, API contracts |
| `backend/OBSERVABILITY.md` | live | observability runbook |
| `infra/CLOUDFLARE.md` | live | Cloudflare cache rules, auth hardening, Caddy `@authdirect` |
| `frontend/PAGINATION.md` | live | pagination algorithm, load-bearing |
| `frontend/DESIGN.md` | live | UI direction |
| `frontend/design/` | live | design tokens (`theme.css`, `tokens.json`, `variables.css`) |

There is no `docs/` directory. A `docs/` directory, if it exists, holds only plans still
being executed; delete a plan when it is finished (git history keeps it).
