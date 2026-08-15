# Agent Guide

> **Architecture (current): self-hosted Next.js frontend + Blueflare Docker origin.** Next.js is rendered by the Node 24 `frontend` container on the VPS and exposed through Caddy at `phim.bluesia.net`. Cloudflare is a normal proxy/CDN only; there is no Astro, frontend Worker, Pages Function, or edge runtime. The same repository owns the API, sync worker, PostgreSQL, Valkey, and signed `m`/`d` image cache behind `img.bluesia.net`. `CLAUDE.md` is authoritative.

## Behavioral guidelines

1. Think before coding; state assumptions and surface tradeoffs.
2. Prefer the smallest change that directly solves the request.
3. Touch only files required by the task and preserve unrelated user changes.
4. Define a verifiable success criterion and run it before reporting completion.

## Runtime assumptions

- Frontend build/runtime: Next.js 16 App Router, React 19, Node 24 standalone output.
- `src/app`, `components`, and browser-safe `lib` code run in the Next runtime; use `process.env` only in server code and `NEXT_PUBLIC_*` for browser-exposed configuration.
- Catalog server helpers use `INTERNAL_CATALOG_URL` (Docker `http://api:3200`) and client helpers use the public API only where browser interaction requires it.
- Caddy proxies `phim.bluesia.net` to `127.0.0.1:3100`; it blocks `/api/internal/revalidate` publicly.
- Movie routes are direct `/movie/[slug]` routes. No rewrite file is needed.

## Local commands

- `npm run dev`: Next dev server.
- `npm run build`: production build and the only automated frontend gate.
- `npm run start`: standalone production server.
- `npm run deploy`: build the frontend Docker image; do not imply it has been deployed.
- `docker compose -f backend/compose.yml config --quiet`: validate VPS composition.

## Editing and performance rules

- Use `apply_patch` for edits; preserve unrelated dirty worktree changes.
- Keep server/client boundaries narrow and parallelize independent server fetches.
- Preserve the rebuilt full-width cinematic shell, responsive gutters, compact mobile navigation, and existing playback ordering.
- Never generate movie context with hash fragments; use `returnTo=<encoded path+search>`.
- Keep the strict compact pagination window in `docs/PAGINATION.md`; do not replace it with endless scroll.
- Images are pre-signed by the API. Use only `thumb_url` (`/i/m/`) and `poster_url` (`/i/d/`); never add client signing, `srcset` variants, or route-specific cache keys.
- The first home hero image is eager/high priority; other images are lazy with stable dimensions.
- Do not mount embeds until the user presses Play; dynamically import only `hls.js/dist/hls.light.js` for MSE fallback.
- Do not proxy, re-chunk, or cache video bytes.

## Verification and response

Report changed files with their purpose, commands and results, and any remaining production-only verification. Do not run a VPS restart, Caddy reload, or external deployment without explicit authorization.
