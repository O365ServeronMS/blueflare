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
- `lib/episodes.ts`, `lib/vsembed.ts`, `lib/types.ts`, `lib/utils.ts`: shared helpers and models.

## Docker backend and deployment

- `backend/compose.yml`: frontend, API, worker, PostgreSQL 17, and Valkey 8.
- `backend/src/`: provider sync, canonical merge, ViewModels, cache, and signed images.
- `backend/deploy/phim.bluesia.net.caddy`: public reverse proxy to frontend port 3100.
- `backend/deploy/img.bluesia.net.caddy`: public reverse proxy to API port 3200.
- `backend/deploy/cloudflare-frontend-static-rule.json`: optional normal Cloudflare cache rule for immutable `/_next/static/` assets.

## Fast search hints

- UI/media: `rg -n "HeroSlider|SectionRow|MovieCard|GlobalNav" components src`
- Catalog contract: `rg -n "getHome|getMovie|normalizeCard|CATALOG_BASE" lib components src`
- Routing/pagination: `rg -n "returnTo|hrefWithPage|Pagination" src components lib`
- Playback: `rg -n "resolvePlaybackSource|hls.light|IframePlayerFacade|location.replace" lib components`
- Cache/images: `rg -n "cacheTag|revalidateTag|getOrBuild|signedImageUrl" src lib backend/src`
