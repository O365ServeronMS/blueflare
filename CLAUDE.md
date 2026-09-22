# FilmBluesia — engineering guide

This file is the single authoritative description of how the project is built and
run. Everything under `docs/` is either a narrower live spec or an archived record;
where they disagree, this file wins.

## Current architecture

FilmBluesia (`phim.bluesia.net`) is a Next.js 16 + React 19 App Router application rendered by a Node 24 standalone container on the VPS. Caddy terminates the public site and reverse-proxies to `127.0.0.1:3100`; Cloudflare is only the normal DNS/TLS/proxy/CDN layer. There is no Astro, frontend Worker, Pages Function, SSR edge runtime, or static-host rewrite.

The repository also owns `backend/`: API, provider sync worker, PostgreSQL, Valkey, and the image cache behind `img.bluesia.net`. Server Components call the API through the Docker network (`INTERNAL_CATALOG_URL`); browser components own playback and browser `localStorage` state. NguonC is primary metadata, KKPhim fills gaps and alternate streams. Video bytes are never proxied.

## The running stack

Seven compose services. Two of them are *supposed* to sit at `Exited (0)` — that is
their designed finished state, not a failure:

| Service | Role |
| --- | --- |
| `frontend` | Next standalone server, published on `127.0.0.1:3100` |
| `api` | catalog API + image cache origin, `127.0.0.1:3200` |
| `worker` | provider sync loop, hero-trending refresh, image prewarm |
| `postgres` | canonical metadata, volume `postgres-data` |
| `valkey` | JSON response cache, `allkeys-lru`, capped |
| `image-cache-init` | one-shot `mkdir`+`chown` of the image cache dir, then `Exited (0)` |
| `backup` | scheduled offsite dump; `Exited (0)` when `BACKUP_ENABLED=false` |

Host-side container names are pinned to `blueflare-<service>` without Compose's
replica suffix. Service-to-service traffic still uses the stable service DNS names
(`frontend`, `api`, `postgres`, and `valkey`), never the host-side container names.

`api` gates on `image-cache-init` completing successfully, because it runs as uid
1000 and would otherwise fail to write a root-owned bind mount.

## Background jobs

Three loops run outside the request path. None of them may be moved into one.

- **Provider sync** (`worker`, every `SYNC_INTERVAL_MS`): crawls NguonC/KKPhim head pages plus a checkpointed backfill, upserts canonical rows, enriches approved visible rows with MDBList Rotten Tomatoes critic/audience scores under a per-key daily budget, refreshes TMDB recommendation/similar id lists for the detail-page rail, refreshes TMDB cast/director credits for rows with a verified TMDB identity, then invalidates Valkey keys and Next render tags for exactly what changed.
- **Image prewarm** (`worker`, end of every sync cycle): reads the same home/list viewmodels the API serves, extracts the asset URLs the next visitor will request, and asks the API to build any that are missing. It never writes the cache itself — it mounts `/data/images` **read-only** and only uses it to skip entries that already exist.
- **Image cache sweep** (`api`, hourly): removes orphan `.tmp` files, and once the cache exceeds `IMAGE_CACHE_MAX_BYTES`, evicts least-recently-read entries back under target. Lives in `api` because **`api` is the only writer of `/data/images`** — keep it that way.

## Commands

```bash
npm run dev       # Next dev server on http://localhost:3000
npm run build     # production Next build
npm run start     # .next/standalone/server.js
npm run preview   # serve the standalone build
npm run deploy    # build the frontend Docker image only
npm test          # vitest, frontend
cd backend && node --test    # backend suite
scripts/deploy.sh [--dry-run] [svc...|all]   # build changed services, recreate, health gate, auto-rollback
scripts/rollback.sh [--dry-run] [svc...]     # swap services back to their previous (:prev) images
```

`scripts/deploy.sh` ships only a clean, pushed `main`, records the running rev in
`/opt/stacks/blueflare/.last-deploy`, and tags each replaced image `:prev`. A
rollback moves images only; it does not undo migrations or synced stack files.

Codebase and runtime are separate directories (ADR-001): the repo lives at `/home/ubuntu/blueflare`, while the Docker stack runs from `/opt/stacks/blueflare` (`compose.yml`, `.env`, `deploy/`, `data/images/`, `backups/`). `deploy/compose.yml` and `deploy/*` in this repo are the source of truth; `deploy/sync-stack.sh` copies them to the stack directory. Compose builds straight from the codebase through `BLUEFLARE_SRC`. Do not run a production restart, a sync, or a Caddy reload unless explicitly requested.

## Source map

- `src/app/`: App Router pages (`/`, `/list/[type]`, `/search`, `/movie/[slug]`, `/person/[slug]`, local libraries, `/healthz`, internal revalidation).
- `components/`: shared React UI, navigation, cards, `CastStrip.tsx`, pagination, playback.
- `lib/catalog.ts`: browser-safe catalog client; `lib/catalog-server.ts`: cached server API helpers.
- `lib/navigation.ts`: returnTo/page URL contracts.
- `lib/playback.ts`: device/source ordering; keep it centralized.
- `src/styles/globals.css`: shared design tokens and Tailwind styles. Accent is red `#e4312a`.
- `backend/src/`: `server.js` (API + sweep scheduler), `worker.js` (sync + rating enrichment + prewarm), `mdblist.js` + `mdblistRatingsSync.js` (batched Rotten Tomatoes scores), `images.js` + `imageStore.js` (cache origin), `prewarm.js`, `imageCacheSweep.js`, `concurrency.js`, `repository.js`, `recommendations.js`, `people.js` (cast/director slug + identity), `viewmodels.js`, `cache.js`.
- `deploy/`: canonical `compose.yml`, Cloudflare rules, `backup/` (backup service image), and operational scripts (`sync-stack.sh`, `apply-env.sh`, `backup-postgres.sh`, `bootstrap-vps.sh`). The two Caddy site blocks live inline in `bootstrap-vps.sh`, not as separate files.

## Data, cache, and navigation invariants

- Catalog data comes only from the repository-owned Blueflare API. Server fetches use the Docker hostname; never add provider calls to a request path.
- Public list/search/detail routes must preserve query parameters. `returnTo=<encoded path+search>` is the only new movie category-context mechanism; do not add hash fragments.
- Pagination is the compact Netflix-style window defined in `docs/PAGINATION.md`; page links must retain type and filters.
- Images are served as exactly two variants: `/i/m/` portrait (480x720) and `/i/d/` landscape (1280x720). Live URLs are **path-only and keyed by `image_assets.id`** (`/i/{m,d}/<uuid>.webp`). An older HMAC-signed `?url=&sig=` form still exists in `images.js` for backward compatibility, but nothing emits it — do not build new callers on it, and never create a third variant.
- `/data/images` has exactly one writer: the `api` service. Anything else that needs it mounts read-only.
- Next render-cache tags and Valkey/API cache keys must not vary by `returnTo`, cookies, authorization, user agent, or analytics parameters.
- `/api/internal/revalidate` is POST-only, secret-protected, and not public through Caddy. The worker sends deduplicated tags in sequential batches of at most 32; the route hard-expires each tag so changed detail data cannot remain stale.

## Playback and loading

- Desktop/Android prefer iframe/embed; iOS prefers native HLS. MSE fallback dynamically imports only `hls.js/dist/hls.light.js`.
- Never mount an embed iframe or autoplay media before an explicit Play action.
- The first visible home hero is the only eager/high-priority image. Other posters/backdrops are lazy and preserve aspect ratio.
- Keep client boundaries small; prefer Server Components and parallel data fetching.

## Backup and recovery

PostgreSQL is the only irreplaceable state. The image cache rebuilds itself from
`image_assets`; Valkey is disposable; the frontend is stateless.

The `backup` service dumps, verifies with `pg_restore --list`, uploads to an
S3-compatible store and prunes both ends. The target is generic on purpose —
changing provider is an env change (`BACKUP_S3_*`), not a code change. The full
rebuild-from-nothing runbook is in `backend/README.md`.

Third-party credentials such as `TMDB_API_KEY`, `MDBLIST_API_KEY`, and
`MDBLIST_API_KEYS` cannot be regenerated by `deploy/bootstrap-vps.sh`; keep a
secure copy off the machine.

## Verification

`scripts/verify.sh` runs the whole checklist and exits non-zero if anything failed
(`--changed` limits it to the sections the working tree touches). The local
`verifier` agent (`.claude/`, not in the repo) runs it and reports only failures.
What it runs:

Run `npm run build` and `npm test` for frontend changes, and `(cd backend && node --test)` for backend changes. Validate the compose file with
`BLUEFLARE_ENV_FILE=$PWD/backend/.env.example docker compose -f deploy/compose.yml config --quiet`
(the absolute `BLUEFLARE_ENV_FILE` is required because the real `.env` only exists in the stack directory), and a container smoke test for `/healthz`, `/list/phim-le?page=2`, `/list/phim-le?page=3`, and protected revalidation. Run `git diff --check HEAD`.

`backend/node_modules` is installed on the host, so `node --test` must be fully
green. If `providers.test.js` fails with `Cannot find package 'pg'`, the directory
is gone — run `npm ci` in `backend/`; do not skip or delete the test.

When adding a key to `backend/.env.example`, add it to the stack `.env` too —
`deploy/apply-env.sh` fails the deploy if `.env` is missing anything the example
documents.

## Documentation map

Live — describes what is running:

- `CLAUDE.md` (this file): architecture and invariants. Start here.
- `backend/README.md`: backend internals, backup/restore, PostgreSQL major upgrades.
- `docs/PAGINATION.md`: pagination algorithm, load-bearing.
- `docs/CLOUDFLARE_CACHE.md`, `docs/OBSERVABILITY.md`, `docs/backend-architecture.md`.
- `docs/blueflare-ui-v2.md`: UI direction. `docs/theme.css`, `docs/tokens.json`, `docs/variables.css` are the design tokens.
- `docs/FILE_MAP.md`: repository layout.

Historical — do **not** read as current state:

- `docs/DECISIONS.md`: chronological decision log. Its UI/navigation/playback entries still explain today's behaviour; its Worker/KV/static-fetch entries describe architectures that no longer exist.
- `docs/adr/`: accepted ADRs and their execution plans. Records of decisions as made, deliberately not rewritten when reality moves on.
- `docs/archive/`: completed plans, superseded designs, dated audits, and an external HBO Max style reference that is **not** this product's design. Every file there carries an `ARCHIVED` banner explaining why.

If a document under `docs/` contradicts this file, this file is correct and the
document is stale — fix or archive it rather than following it.
