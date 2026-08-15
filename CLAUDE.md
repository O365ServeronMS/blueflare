# FilmBluesia — engineering guide

## Current architecture

FilmBluesia (`phim.bluesia.net`) is a Next.js 16 + React 19 App Router application rendered by a Node 24 standalone container on the VPS. Caddy terminates the public site and reverse-proxies to `127.0.0.1:3100`; Cloudflare is only the normal DNS/TLS/proxy/CDN layer. There is no Astro, frontend Worker, Pages Function, SSR edge runtime, or static-host rewrite.

The repository also owns `backend/`: API, provider sync worker, PostgreSQL, Valkey, and the signed image cache behind `img.bluesia.net`. Server Components call the API through the Docker network (`INTERNAL_CATALOG_URL`); browser components own playback and browser `localStorage` state. NguonC is primary metadata, KKPhim fills gaps and alternate streams. Video bytes are never proxied.

## Commands

```bash
npm run dev       # Next dev server on http://localhost:3000
npm run build     # production Next build (the automated gate)
npm run start     # .next/standalone/server.js
npm run preview   # serve the standalone build
npm run deploy    # build the frontend Docker image only
```

The VPS stack is operated from `backend/` with Docker Compose. Do not run a production restart or Caddy reload unless explicitly requested.

## Source map

- `src/app/`: App Router pages (`/`, `/list/[type]`, `/search`, `/movie/[slug]`, local libraries, `/healthz`, internal revalidation).
- `components/`: shared React UI, navigation, cards, pagination, playback.
- `lib/catalog.ts`: browser-safe catalog client; `lib/catalog-server.ts`: cached server API helpers.
- `lib/navigation.ts`: returnTo/page URL contracts.
- `lib/playback.ts`: device/source ordering; keep it centralized.
- `src/styles/globals.css`: shared design tokens and Tailwind styles.
- `backend/`: VPS origin and Compose deployment.

## Data, cache, and navigation invariants

- Catalog data comes only from the repository-owned Blueflare API. Server fetches use the Docker hostname; never add provider calls to a request path.
- Public list/search/detail routes must preserve query parameters. `returnTo=<encoded path+search>` is the only new movie category-context mechanism; do not add hash fragments.
- Pagination is the compact Netflix-style window defined in `docs/PAGINATION.md`; page links must retain type and filters.
- Images arrive pre-signed as exactly two variants: `/i/m/` portrait and `/i/d/` landscape. The frontend never signs, re-keys, or creates a third variant.
- Next render-cache tags and Valkey/API cache keys must not vary by `returnTo`, cookies, authorization, user agent, or analytics parameters.
- `/api/internal/revalidate` is POST-only, secret-protected, and not public through Caddy.

## Playback and loading

- Desktop/Android prefer iframe/embed; iOS prefers native HLS. MSE fallback dynamically imports only `hls.js/dist/hls.light.js`.
- Never mount an embed iframe or autoplay media before an explicit Play action.
- The first visible home hero is the only eager/high-priority image. Other posters/backdrops are lazy and preserve aspect ratio.
- Keep client boundaries small; prefer Server Components and parallel data fetching.

## Verification

Run `npm run build`, `docker compose -f backend/compose.yml config --quiet`, and a container smoke test for `/healthz`, `/list/phim-le?page=2`, `/list/phim-le?page=3`, and protected revalidation. Run `git diff --check`.
