# FilmBluesia

A Vietnamese movie streaming catalog at [phim.bluesia.net](https://phim.bluesia.net) — browse, search, and watch movies with a fast, mobile-first interface.

## What it does

- Browse and search the canonical Vietnamese catalog merged by the Blueflare Docker backend.
- Stream through device-aware embeds or direct HLS playback.
- Remember favorites and watch history in browser `localStorage`.
- Render public pages with Next.js on the VPS, while Cloudflare provides ordinary TLS/proxy/CDN caching.

## Current architecture

The frontend is a self-hosted Next.js 16 App Router application. It runs in the `frontend` Docker service on the VPS and is exposed locally on `127.0.0.1:3100`; Caddy serves `phim.bluesia.net` by reverse proxy. No Astro, Cloudflare Worker, Pages Function, or frontend edge runtime is used.

The same repository owns the Blueflare backend under `backend/`: provider sync, canonical PostgreSQL data, Valkey response caching, and signed `m`/`d` images at `img.bluesia.net`. Server Components call the API over the Docker network; browser components handle playback and local-only user state.

## Stack

| What | How |
|---|---|
| Pages and routing | Next.js 16 App Router, React Server Components |
| Interactive UI | React 19 client components only where needed |
| Styling | Tailwind CSS 4 |
| Runtime | Node 24 standalone container on the VPS |
| Public boundary | Caddy + Cloudflare normal proxy/CDN, no Worker |
| Catalog and images | Blueflare API at `img.bluesia.net/api/*` |
| Providers | NguonC primary; KKPhim fallback/alternate streams |
| Data/cache | PostgreSQL canonical catalog + Valkey final responses + Next render cache |
| Images | Signed `m`/`d` variants (frontend never signs) |
| Video | hls.js light build (dynamic fallback) + provider embeds |

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run build      # production Next build
npm run start      # serve the standalone build
```

For the full VPS stack:

```bash
cd backend
cp .env.example .env
sudo docker compose --env-file .env -f compose.yml up -d --build
```

## Deploy on the VPS

The repository does not deploy a frontend Worker. Build and restart the frontend container through the backend Compose stack:

```bash
cd /home/ubuntu/blueflare/backend
sudo docker compose --env-file .env -f compose.yml up -d --build frontend
sudo docker compose --env-file .env -f compose.yml ps frontend
curl -fsS http://127.0.0.1:3100/healthz
```

After validating Caddy, reload it with the normal host runbook in [`backend/README.md`](backend/README.md).

## Project layout

```
src/app/          # Next App Router pages, route handlers, loading/error states
components/       # Shared React UI, cards, navigation, pagination, playback
lib/              # Browser catalog helpers and server-side cached API helpers
public/            # Favicon, manifest, robots, sitemaps, static assets
backend/           # VPS Docker origin: API, worker, PostgreSQL, Valkey, signed images
Dockerfile.frontend# Production standalone Next image
docs/              # Architecture, cache, pagination, and migration notes
```

Navigation keeps category context in `returnTo=<encoded path+search>`; movie pages are served directly by `/movie/[slug]`, so page 2/3/etc. remains addressable and reload-safe.

The only automated frontend gate is:

```bash
npm run build
```
