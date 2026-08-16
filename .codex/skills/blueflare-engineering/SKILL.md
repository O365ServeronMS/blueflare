---
name: blueflare-engineering
description: Make precise, low-risk changes in the Blueflare/FilmBluesia repository. Use when implementing, reviewing, debugging, or refactoring its Next.js frontend, Docker backend, catalog API, provider sync, PostgreSQL/Valkey caching, image delivery, navigation, or playback.
---

# Blueflare Engineering

Use this skill to turn a request into the smallest safe Blueflare change. Treat `CLAUDE.md` as the authoritative project specification; use `AGENTS.md` for Codex execution rules.

## Work deliberately

1. Inspect the relevant code and nearby tests before editing. Check `git status --short` first and preserve unrelated changes.
2. State the concrete assumption only when it affects scope, user-visible behavior, architecture, or production operations. Ask instead of silently selecting a materially different behavior.
3. Define an observable success criterion before modifying code. For a multi-step task, keep a short plan with a verification for each risky step.
4. Make the minimum coherent change. Match local patterns; do not add a framework, abstraction, setting, migration, fallback, or unrelated cleanup unless the request needs it.
5. Remove only imports, variables, tests, or code made obsolete by the current change. Report unrelated issues without changing them.
6. Inspect the diff and run the narrowest meaningful checks, then expand to required project gates. Do not call a change complete without reporting what was verified and what remains production-only.

Every modified line must trace to the request or to an immediate correctness requirement it creates.

## Establish scope and verification

Choose checks by touched surface:

| Surface | Minimum verification |
| --- | --- |
| Frontend or shared TypeScript | `npm run build` |
| Backend JavaScript or provider behavior | `cd backend && npm test` |
| Compose or deployment configuration | `docker compose -f backend/compose.yml config --quiet` |
| Pagination | Validate all examples in `docs/PAGINATION.md` |
| Internal revalidation/cache boundary | Verify POST-only, secret protection, and public Caddy denial |
| UI/playback behavior | Exercise the affected route or component; do not claim device behavior without a relevant runtime check |

Always run `git diff --check` for a code/configuration change. If an applicable check cannot run, state the command, why, and the remaining risk. Do not restart VPS services, reload Caddy, deploy, mutate production data, or call third-party providers unless explicitly authorized.

## Preserve architecture boundaries

- Keep Next.js 16 App Router and React 19 on the Node 24 standalone frontend. Caddy proxies `phim.bluesia.net` to `127.0.0.1:3100`; Cloudflare is CDN/proxy only. Do not introduce an edge runtime, Worker, Pages Function, Astro, static rewrite, or new hosting model without an explicit architecture request.
- Keep provider traffic in the backend sync worker. Request rendering reads only the repository-owned Blueflare API; Server Components use `INTERNAL_CATALOG_URL` (`http://api:3200`) and browser code uses the public API only when interaction requires it.
- Keep server/client boundaries narrow. Prefer Server Components and parallel independent server fetches. Use `process.env` only on the server and expose browser configuration only through `NEXT_PUBLIC_*` values.
- Keep browser-only favorites/history in `localStorage`; do not move that state into catalog requests or cache keys.
- Preserve direct `/movie/[slug]` routing. Do not add rewrite rules.

## Preserve data, cache, and URL contracts

- Keep catalog list/search/detail data behind the Blueflare API. Do not make provider calls or browser request paths wait for crawling.
- Use only `returnTo=<encoded path+search>` for movie category context; preserve existing query parameters. Never create hash-fragment context.
- Retain the strict compact Netflix-style pagination algorithm in `components/Pagination.tsx`; never substitute endless scroll or a generic page window.
- Use only pre-signed `thumb_url` (`/i/m/`) and `poster_url` (`/i/d/`) images. Do not sign in the client, use `srcset`, create a third variant, or make cache identity route-specific.
- Keep Next render-cache tags and API/Valkey cache keys independent of `returnTo`, cookies, authorization, user agent, and analytics parameters.
- Keep `/api/internal/revalidate` POST-only, secret-protected, Docker-network-only, and publicly blocked by Caddy.

## Preserve visual and playback contracts

- Preserve the full-width cinematic shell, responsive gutters, compact mobile navigation, and established playback order.
- Make only the first visible home hero eager/high priority. Keep all remaining images lazy with stable dimensions/aspect ratio.
- Do not mount an iframe, embed, or autoplay media until the user explicitly presses Play.
- Keep desktop/Android iframe/embed preference and iOS native HLS preference. For MSE fallback dynamically import only `hls.js/dist/hls.light.js`.
- Never proxy, re-chunk, or cache video bytes.

## Backend-specific guardrails

- Preserve NguonC as primary presentation metadata; use KKPhim to fill gaps and provide alternate streams.
- Preserve deterministic provider identity resolution and canonical catalog ordering; do not let a backfilled old movie masquerade as newly updated.
- Store canonical metadata/provenance and image source URLs, not provider payloads or image bytes. Keep the two image variants `m` (480×720) and `d` (1280×720).
- Treat Valkey as final-response cache and PostgreSQL as canonical data. Protect migration compatibility and cache invalidation boundaries when changing either.

## Finish cleanly

Review the final diff for unintended file changes and formatting errors. Report changed files with their purpose, commands and results, and production-only verification that was intentionally not performed.
