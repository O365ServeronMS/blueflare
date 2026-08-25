# Blueflare File Map

This map describes the current Next.js frontend and repository-owned Docker
origin. Historical static/Worker notes are retained only in explicitly marked
archive documents.

## Root and configuration

- `package.json`: Next.js/React commands and runtime dependencies.
- `next.config.ts`: standalone output, render-cache mode, and response headers.
- `Dockerfile.frontend`: Node 24 production image for the standalone server.
- `tsconfig.json`, `postcss.config.mjs`: TypeScript and Tailwind/PostCSS setup.
- `CLAUDE.md`: authoritative architecture and implementation guide.

## Frontend routes

- `src/app/page.tsx`: server-rendered home and hero/section data.
- `src/app/list/[type]/page.tsx`: paginated list route with country/category filters.
- `src/app/search/page.tsx`: no-store search route with pagination.
- `src/app/movie/[slug]/page.tsx`: server-rendered detail/player shell and episode state.
- `src/app/favorites/page.tsx`, `history/page.tsx`: browser-local libraries.
- `src/app/settings/page.tsx`, `not-found.tsx`, `error.tsx`: information/recovery screens.
- `src/app/healthz/route.ts`: container health probe.
- `src/app/api/internal/revalidate/route.ts`: secret-protected targeted render-cache invalidation.

## Frontend components and libraries

- `components/`: GlobalNav, HeroSlider, SectionRow, MovieCard, Pagination,
  MoviePlayer, HlsVideo, IframePlayerFacade, local actions/grids, and shared UI.
- `lib/catalog.ts`: browser-safe catalog client.
- `lib/catalog-server.ts`: cached server API helpers and cache tags.
- `lib/navigation.ts`: `returnTo` and category-context policy.
- `lib/playback.ts`: centralized device/source priority and URL validation.
- `lib/episodes.ts`, `lib/types.ts`, `lib/utils.ts`: shared helpers and models.

## Docker backend and deployment

Runtime sống ở `/opt/stacks/blueflare`, không nằm trong repo — xem
`docs/adr/ADR-001-tach-stack-runtime-khoi-codebase.md`. Các file dưới đây là **bản chuẩn**
trong git; thư mục stack giữ bản copy, đồng bộ bằng `deploy/sync-stack.sh`.

- `deploy/compose.yml`: frontend, API, worker, PostgreSQL, Valkey, one-shot `image-cache-init`, và service `backup`. Build context
  trỏ về codebase qua `${BLUEFLARE_SRC:-/home/ubuntu/blueflare}`.
- `deploy/sync-stack.sh`: copy compose + script vận hành từ repo sang thư mục stack.
- `deploy/apply-env.sh`: validate `.env` rồi tạo lại container, không rebuild.
- `deploy/backup-postgres.sh`: wrapper mỏng chạy một lần service `backup` (`compose run --rm backup --once`).
- `deploy/backup/`: image + script của service backup (dump, verify, upload S3-compatible, prune).
- `backend/src/`: provider sync, canonical merge, ViewModels, cache, image cache origin.
  Job nền: `prewarm.js` (worker làm ấm cache ảnh), `imageCacheSweep.js` (API dọn/evict cache).
- `deploy/bootstrap-vps.sh`: dựng VPS trắng; hai site block Caddy (`phim` → 3100,
  `img` → 3200) nằm inline trong script, không còn file `.caddy` riêng.
- `deploy/cloudflare-frontend-static-rule.json`: optional normal Cloudflare cache rule for immutable `/_next/static/` assets.

Chỉ tồn tại ở thư mục stack, **không** trong git: `.env` (secret),
`.env.example` (bản copy của `backend/.env.example`, đồng bộ bằng `sync-stack.sh`),
`data/images/` (cache ảnh), `backups/postgres/` (dump local, bản offsite nằm trên R2).

## Fast search hints

- UI/media: `rg -n "HeroSlider|SectionRow|MovieCard|GlobalNav" components src`
- Catalog contract: `rg -n "getHome|getMovie|normalizeCard|CATALOG_BASE" lib components src`
- Routing/pagination: `rg -n "returnTo|hrefWithPage|Pagination" src components lib`
- Playback: `rg -n "resolvePlaybackSource|hls.light|IframePlayerFacade|location.replace" lib components`
- Cache/images: `rg -n "cacheTag|revalidateTag|getOrBuild|imageUrl|prewarm|sweep" src lib backend/src`
