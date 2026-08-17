# Decisions And Anti-Regression Rules

> **Architecture update (zero-Worker static + catalog-api).** The site is now a
> static, no-Worker deployment that fetches all catalog data, TMDB metadata, and
> pre-signed images from the VPS `catalog-api` (`img.bluesia.net/api/*`) client-side.
> Decisions below about SSR, the data Worker, KV metadata cache, HTML Cache API,
> image signing in-app, and metadata snapshots are historical. UI, navigation, and
> playback decisions remain in force. `CLAUDE.md` is authoritative.

## 2026-06-24 Movie Detail Hero LCP Preload (reverses 2026-06-13 backdrop deprioritization)

- **Decision**: The `/movie/[slug]` hero backdrop image uses `fetchpriority="high"` + `loading="eager"` and is preloaded via `<link rel="preload" as="image">` (mobile `m` / desktop `d` variants). This reverses the 2026-06-13 `Jun26-v3-img-perf` rule below that set the backdrop to low/lazy and removed its preload.
- **Reason**: Since the 2026-06-16 external signed image cache decision, all active backdrop rendering routes through `img.bluesia.net`, which serves size-optimized `webp` `m`/`d` variants. The original "multi-megabyte raw OPhim backdrop" concern that motivated low/lazy no longer applies to the signed path. The backdrop is the LCP element on the movie detail page; deprioritizing it delayed LCP by ~1–2s on mobile.
- **Scope**: Applies to the signed `img.bluesia.net` path. The raw-upstream fallback (`heroImage`) is preloaded only when signing env vars are absent (non-production); do not preload raw OPhim backdrops in production.
- **Cache invalidation**: No `HTML_CACHE_VERSION` bump needed. Per the 2026-06-18 decision, HTML cache keys are scoped to `WORKER_VERSION.id`, so the next deployment regenerates movie HTML with the new preload automatically.
- **Anti-regression**: Keep the home hero preload (`src/pages/index.astro`) and the movie detail hero preload consistent. Only `m`/`d` variants; no width/quality/DPR params (shared image cache invariant).

## 2026-06-18 Deployment-Scoped HTML Cache And Binding Cleanup

- **Decision**: HTML Cache API keys use the Cloudflare `WORKER_VERSION.id` binding. Every deployment gets a new cache namespace automatically, so old HTML cannot reference a new deployment's replaced Astro assets.
- **Bindings**: Keep `ASSETS`, metadata `KV`, and `WORKER_VERSION`. The old site-local `IMAGE_CACHE` R2 binding is removed because active images use the external signed cache at `img.bluesia.net`.
- **Variables**: Production keeps only `IMAGE_CACHE_BASE_URL`; refresh tuning uses code defaults. `HTML_CACHE_VERSION` is a fallback for environments without Version Metadata, not a production deploy knob.
- **Secrets**: Keep `IMAGE_CACHE_SIGNING_SECRET` and `ADMIN_REFRESH_TOKEN` because both have active server-side call-sites. Never expose either through a `PUBLIC_` variable.

## 2026-06-18 Unified Movie Detail And Playback Page

- **Decision**: The only movie flow is List/Home -> `/movie/[slug]`. Movie metadata, episode selection, and playback live on the same page.
- **Playback gate**: The `Xem phim` action reveals the selected player without autoplay. Embed playback keeps a second explicit Play interaction before the iframe is created. Direct HLS playback renders controls without an autoplay attribute.
- **Source priority**: Desktop and Android prefer the iframe/embed source. iOS prefers direct native HLS. When embed is unavailable or HLS is explicitly requested, MSE-capable non-iOS browsers use the light hls.js build loaded through a dynamic import; iOS still attempts native HLS before any library path.
- **Episodes**: Episode links update `/movie/[slug]` with `server`, `ep`, and `play=1`, preserve `returnTo`, and replace same-page episode history so browser Back returns to the source list instead of older episode selections.
- **Runtime boundary**: Video remains browser-to-upstream. Do not proxy, cache, download, or re-chunk iframe/HLS media through Cloudflare.

## 2026-06-16 Shared Image Cache Invariant

- **Decision**: `film.bluesia.net` (Astro) and `phim.bluesia.net` (Next.js) MUST use the exact same external image cache service (`https://img.bluesia.net`). The cache key MUST be derived ONLY from the **normalized upstream image URL** and the **variant** (`m` or `d`).
- **Reason**: To avoid double image cache generation and save CDN storage, a single upstream poster must generate identical signed URLs on both frontends.
- **Rejected approach**: The cache key MUST NOT include requester site domain, frontend name, page route, movie slug, or frontend-local width/quality parameters. Site-local image proxies (`/api/image` or `/_next/image`) are explicitly forbidden for active rendering.

## 2026-06-16 Responsive Image Rendering Pattern

- **Decision**: Responsive image rendering across the application (cards, hero sliders, search suggestions, detail pages) must use both `m` (mobile) and `d` (desktop) signed `img.bluesia.net` URLs via `srcset`/`sizes` or `<picture>` elements. The default/fallback `src` for desktop-capable tags is always the `d` variant.
- **Reason**: Hard-coding the `m` variant as the default `src` caused desktop browsers to fetch and display blurry low-resolution posters, and led to suboptimal cache behavior. Using native responsive HTML attributes allows the browser to correctly pick the resolution without relying on server-side user-agent parsing.
- **Rejected approach**: Do not hard-code the `m` variant for all generic cards. Do not use user-agent detection to switch variants. Do not default to `m` as the fallback `src`.

## 2026-06-16 External Signed Image Cache for Active Rendering

- **Decision**: Project 1 (FilmBluesia Astro) uses the external signed image cache at `img.bluesia.net` for all active poster/backdrop rendering. The legacy `/api/image` proxy endpoint and all `proxiedImage()` fallback branches have been removed.
- **Reason**: Avoid duplicate image optimization logic between the Worker proxy and VPS cache, align image URL contract with Project 2 (Vercel), reduce inconsistent image URLs in rendered HTML, and simplify the image pipeline to a single delivery path.
- **Rejected approach**: Do not revive `/api/image?url=...&profile=...` for active rendering. Do not introduce width/quality/DPR/format parameters from the frontend.
- **What changed**: Deleted `src/pages/api/image.ts` endpoint and `scripts/test-image-proxy.mjs`. Removed `proxiedImage()`, `proxiedImageSrcSet()`, `proxiedImageCandidateSrcSet()`, and `ImageProfile` from `lib/utils.ts`. Removed all `/api/image` fallback branches from `MovieCard.tsx`, `HeroSlider.tsx`, `SearchSuggest.tsx`, `IframePlayerFacade.tsx`, `movie/[slug].astro`, `watch/[slug].astro`, and `index.astro`. OG/meta images now use signed desktop variant with raw upstream fallback.
- **Image URL format**: `https://img.bluesia.net/i/{m|d}/{sha256}.webp?url={encoded-upstream}&sig=v1.{hmac-hex}`
- **Only variants**: `m` (mobile), `d` (desktop). No other variants, profiles, or parameters.
- **Env vars**: `PUBLIC_IMAGE_CACHE_URL` (base URL), `IMAGE_CACHE_SIGNING_SECRET` (HMAC key, server-only).
- **Fallback when env missing**: Components use raw upstream URLs (not a proxy), with client-side error handler cascade in `BaseLayout.astro`.

## 2026-06-15 Image Source Registry

- `/api/image` validates source image URLs through an Image Source Registry instead of a closed hard-coded host check. The registry keeps known OPhim image hosts and can be extended at runtime with `IMAGE_ALLOWED_HOSTS` for exact hosts and `IMAGE_ALLOWED_HOST_SUFFIXES` for trusted suffixes such as `.ophim.live`.
- The original image URL from the `url` query param is always candidate `0` and must be attempted before any mirror. Do not silently rewrite `img.ophim.live` to `img.ophim1.com` or older hosts before the original request is tried.
- Default OPhim mirror candidates are `img.ophim.live` and `img.ophim1.com`. `img.ophim.cc` is not a default allowed host or fallback candidate because it has returned `404 application/json` for valid-looking poster paths; add it only through env after path-level verification.
- OPhim image cache keys use a stable provider identity for trusted mirrors: `ophim:<pathname>:<profile>:<image-cache-version>`. This prevents R2 lookup from using one mirror while put uses another for the same poster path.
- Upstream response classification happens before optimization. `404` logs `IMAGE_UPSTREAM_NOT_FOUND`, non-image `200` logs `IMAGE_UPSTREAM_NON_IMAGE`, candidate fetch/redirect/host failures log `IMAGE_ORIGIN_ATTEMPT_FAIL`, and `IMAGE_OPTIMIZE_FAIL` is reserved for failures after a valid `200 image/*` origin response reaches the optimizer.
- The image proxy still must not become an open proxy. It rejects non-http/https protocols, unknown external hosts, localhost, IP addresses, and private/internal-style hostnames before any origin fetch.
- Trusted suffixes allow future OPhim CDN host changes under approved domains, for example `img.ophim.live` or another subdomain of `.ophim.live`, without code changes.
- Unknown hosts return structured JSON with `IMAGE_HOST_NOT_ALLOWED`; validation errors are `no-store`, upstream failures are cacheable for at most 300 seconds, and only successful image responses receive the long image cache policy.
- Card image fallback remains poster first, then thumb, then a local placeholder. Proxy upstream failures must return error statuses so browser image fallback can run.

## 2026-06-13 Movie Image Normalization

- Movie image mapping belongs in the data layer, not in `MovieCard` or route templates. `lib/movie-images.ts` owns `normalizeMovieImage()`, `resolveMoviePoster()`, and `normalizePosterUrl()`, and `lib/ophim.ts` must normalize cards through that helper.
- OPhim/source movie payloads may expose image fields as `posterUrl`, `poster_url`, `poster`, `thumbUrl`, `thumb_url`, `thumb`, `thumbnail`, `image_url`, or `image`. Prefer poster fields, fall back to thumb fields, and only render `No image` when all usable image fields are absent.
- Relative image paths must be normalized through the existing OPhim image CDN base logic. Do not hardcode a new image domain or duplicate source-specific mapping inside UI components.
- Cache bump for this incident: metadata KV list/detail keys include `img-fields-v2` (`list:img-fields-v2:<hash>`, `detail:img-fields-v2:<slug>`), and HTML cache version is `Jun26-v2-img-fields` so home/list/movie HTML is regenerated with corrected poster data.

## 2026-06-13 Image Proxy Origin Fallback

- The image proxy must not return the `No image` SVG when OPhim returns a successful valid image content type. Cloudflare image transform may return WebP on supported plans, but production can also return the upstream JPEG/PNG/AVIF directly; those responses are valid and should be cached with their actual `Content-Type`.
- Keep fixed image profiles and the active R2 namespace `cf-img-jun-2026-v2`; do not create arbitrary width/quality variants.
- Oversized untransformed origin images must not be served or written into profile cache keys. `poster-mobile` must never silently become a multi-megabyte original JPEG.
- Above-the-fold decorative art should prefer poster over thumb/backdrop because some OPhim thumb files are multi-megabyte. Do not preload or high-priority fetch large backdrop profiles unless Cloudflare transform is verified active.
- Cache bump for this performance change: HTML cache version is `Jun26-v3-img-perf` so home and movie detail HTML stops preloading/eager-loading heavy backdrop images from stale cached HTML.
- Cache bump for oversized origin rejection: use R2 namespace `cf-img-jun-2026-v2` and include `reject-large-origin-v1` in the internal edge cache key so stale image objects are bypassed while rejecting oversized cached origin JPEG/PNG/AVIF objects before serving them.
- 2026-06-15 production vars should match the Worker settings screenshot: `HTML_CACHE_VERSION=Jun26-v4`, `BLUESIA_IMAGE_TRANSFORM_MODE=cloudflare-free`, `NEXT_PUBLIC_SITE_URL=https://film.bluesia.net`, `OPHIM_REFRESH_DELAY_MS=1500`, and `OPHIM_REFRESH_MAX_MOVIES=24`. Secrets such as `ADMIN_REFRESH_TOKEN` remain Cloudflare-managed and must not be committed.

## 2026-06-09 Return-To Navigation Context

- Use full `returnTo` path+search for list → unified movie page navigation. Do not rely on `from` or hash fragments for category context.
- Generated movie links carry `returnTo` with the encoded current pathname and search, so paginated and filtered list state is preserved.
- Player and episode links remain on `/movie/[slug]` and preserve the same `returnTo` value.
- Active bottom-nav context is derived from `returnTo` first, then legacy `from` parsing and movie metadata fallback.
- Episode changes replace the current unified movie URL so episode-to-episode selections do not pollute browser history.
- The movie page back control may use safe `returnTo` to restore the original list/home page. Browser-native Back cannot restore a list page when a movie page is opened in a new tab; do not create fake history entries for this.

## 2026-06-09 Adaptive Client-Side Prefetch

- Added adaptive client-side prefetch in `src/client/adaptivePrefetch.ts`, initialized globally from `src/layouts/BaseLayout.astro`.
- Navigation habit tracking is localStorage-only under `filmbluesia_nav_stats_v1`; this keeps behavior personal to each browser and avoids server-side tracking, Cloudflare KV writes, or external analytics.
- Route transitions are recorded as previous normalized route/category -> current normalized route/category counts. Unified detail/playback pages normalize to `/movie`; legacy `/watch` redirects remain excluded from playback prefetching.
- Prediction thresholds are intentionally conservative: minimum transitions from the current route is `5`, and the best target must have probability at least `0.45`. Only the single best next route may be considered per page view.
- Safety limits keep storage small: at most `24` source routes, at most `8` target routes per source, and lowest-count entries are pruned first.
- Safe prefetch runs only after page load and during idle time with a `setTimeout` fallback. It skips when localStorage/sessionStorage is unavailable, when `navigator.connection.saveData` is true, or on `slow-2g`/`2g` connections.
- Prefetch is limited to one predicted route per page view, deduped within the browser session, and only warms safe list resources: category/list route HTML and the first-page `/api/ophim/list/[type]` API that already exists.
- Strict rule: never prefetch video/HLS/playback resources. The prefetch mapper never targets `/watch`, `/movie`, player/embed/playback paths, or `.m3u8`, `.ts`, `.m4s`, `.mp4` resources.
- Changed files: `src/client/adaptivePrefetch.ts`, `src/layouts/BaseLayout.astro`, `docs/DECISIONS.md`, and `AI_MEMORY.md`.
- Build/test result: `npm run build` passed on 2026-06-09. No lint/typecheck script exists in `package.json`; Astro build is the available verification.

## 2026-06-09 HLS Playback Strategy

- Desktop and Android prefer the iframe/embed source when it exists. iOS prefers direct native HLS; embed remains its fallback when no HLS URL exists.
- Desktop and Android use a valid API iframe/embed before any direct HLS path, reducing client HLS parsing and buffering work. iOS/iPadOS uses native Safari HLS before iframe playback.
- The light hls.js build is fallback-only when native HLS is unsupported and no usable iframe/native path remains; it is dynamically imported so it is absent from the initial player chunk.
- `components/HlsVideo.tsx` must keep `hls.js/dist/hls.light.js` as a dynamic import inside the direct player path; do not import hls.js globally or switch back to the full build.
- Fatal hls.js errors recover by type: network errors call `startLoad()`, media errors call `recoverMediaError()`, and other fatal errors destroy hls.js before attempting native HLS fallback.

## 2026-06-15 HLS Player Controls

- Main OPhim HLS playback continues to use `hls.js` directly through `components/HlsVideo.tsx`; do not restore ArtPlayer or another heavy player library as the main HLS player.
- Production player UI must not show an hls.js readiness/debug/status badge, including `Sẵn sàng phát bằng hls.js`.
- Keep the HLS UI minimal: use native video controls only. Do not add a custom quality selector or local subtitle upload/conversion controls.
- hls.js adaptive bitrate selection remains automatic on the fallback path, reducing player state, event listeners, UI code, and initial interaction overhead.

## Platform

- The app targets Astro server output with the Cloudflare adapter.
- Keep Worker/edge compatibility. Avoid Node-only APIs unless they are already supported by configured compatibility and tested by build/preview.
- Do not introduce filesystem runtime persistence; use Cloudflare KV/Cache API or browser storage according to existing patterns.
- Preserve `src/worker.ts` as the custom Worker entrypoint that forwards Astro fetch and owns scheduled refresh behavior.
- Cloudflare bindings have separate roles: `KV` stores metadata, `WORKER_VERSION` isolates HTML cache keys per deployment, and `ASSETS` serves static files.
- `ASSETS` is the static assets binding required by the Astro Worker fallback through `env.ASSETS.fetch()`.
- Do not confuse R2/KV bindings with `assets.binding`; missing `ASSETS` can cause `/_astro/*.css` or `/_astro/*.js` requests to fail with Worker Exception 1101.

## Caching

- HTML cache behavior lives in `src/middleware.ts`; metadata cache behavior lives in `lib/cache.ts` and `lib/ophim.ts`; active image delivery uses `lib/image-cache.ts` and `img.bluesia.net`.
- Do not change unrelated cache keys, cache key prefixes, TTLs, `HTML_CACHE_VERSION`, or binding names unless explicitly requested.
- Movie HTML cache duration depends on `X-Film-Bluesia-Movie-Cache-Class` from the detail page.
- Search, watch, favorites, history, and settings should remain no-store/private HTML unless a task explicitly changes that.
- External image cache URLs use only `m` and `d` variants; do not add arbitrary width/quality parameters.
- Refresh writes should preserve stable-hash deduplication and daily KV write-budget behavior.
- Do not reintroduce a site-local R2 image cache while the shared external image cache contract is active.

## Data

- OPhim metadata normalization is centralized in `lib/ophim.ts`; prefer extending `normalizeCard()` and shared types instead of duplicating shape logic in UI.
- Shared movie/source types belong in `lib/types.ts`.
- Display-specific formatting belongs in `lib/utils.ts` or components, not in API route handlers.
- Need verification: no D1 binding is evident in `wrangler.jsonc`; do not assume active D1 storage without checking current config.

### TMDB poster fallback is a guess, and must stay quarantined from identity

- Providers sometimes supply no artwork at all (NguonC returns its bare domain as `thumb_url`). Such rows also carry no `tmdb_id`/`imdb_id`, so the verified-by-id pipeline cannot reach them; `refreshTmdbImageFallbacks()` guesses identity from `original_title` instead.
- These rows have no year, so title equality is the only evidence available. Accept only an unambiguous exact-title match that has a poster; decline ambiguous and near-miss results. A wrong poster is worse than the placeholder.
- Never write a search-derived match into `movies.tmdb_id`. Identity resolution reads that column, so a bad guess could merge two unrelated titles. The matched id belongs in `tmdb_image_fallback_id`, which identity never reads.
- Only rows with no provider artwork are eligible, so a borrowed poster can never displace a real one. Every borrowed poster is reversible by selecting `tmdb_image_fallback_status='matched'`.

## UI

- The app is mobile-first with a constrained shell in `BaseLayout.astro` and fixed bottom nav in `BottomNav.tsx`.
- Preserve existing mobile layout unless the task says otherwise.
- Avoid broad UI refactors for small card/layout changes.
- Shared poster-card changes should usually happen in `components/MovieCard.tsx` so home, lists, search, favorites, and history stay consistent.
- Keep favorite/heart, Full/episode, and quality badge positions stable when changing poster overlay content unless the task explicitly changes them.
- Existing UI uses Tailwind classes and lucide-react icons; reuse those patterns.

## Navigation Hierarchy And Browser Back Behavior

- Category/List -> unified `/movie/[slug]` is the canonical hierarchy.
- `Xem phim` opens the player in place and must not push a new route into browser history.
- Browser Back from a movie page must return to the exact previous category/tab page, including list filters and pagination in `returnTo`.
- Episode changes are same-level state changes and use replace navigation; browser Back must not loop through earlier episode selections.
- Active bottom tab/category is derived from URL context and must not reset to `Trang chủ` during hydration or route restoration.
- The in-page up/back control uses `data-nav-back` with a safe `returnTo` fallback so direct-opened movie URLs still work.
- `/watch/[slug]` is legacy redirect compatibility, not a navigation hierarchy level.
- Manual check: open each main category, open a poster, reveal the player, select several episodes, then press Back once and verify the original category/list URL and active tab are restored.

## Episode Selection Must Not Pollute Browser History

- Episode changes on the unified movie page are same-level state changes, not new hierarchy levels.
- Selecting episodes must not push a new browser history entry per episode.
- Use replace navigation or internal state for episode-to-episode changes.
- Do not use `history.go(-N)`, `setTimeout`, or stack-skipping hacks.
- Manual check: select Episode 3, Episode 5, then Episode 6 and press Back once; the original category/list page must be restored.

## Bottom Nav Source Tab Must Persist Across Child Pages

- Navigation policy: category context for `/movie` pages should be carried by `returnTo=<encoded path+search>`, not hash fragments. Hash fragments are unavailable during Astro/server/static render. Bottom nav active state should use pathname plus `returnTo` and optional movie category fallback. Do not change Cloudflare/cache/video logic for nav active-state fixes.
- The legacy `from` and hash fallback exists only for old cached links after client load. New generated child links must use `returnTo`.

- Unified movie pages are child pages of the source tab/category.
- Opening a movie from a bottom-nav tab must keep that tab active while detail, player, and episode states are shown.
- Active tab must not be derived only from the current pathname because `/movie/...` is a child route.
- Do not default direct movie pages to `Trang chủ` when source context is unknown; unknown direct child URLs should have no forced source tab.
- Preserve source context through player reveal, episode replacement, legacy redirects, and browser Back navigation.
- Manual check: open each main tab, open a movie, reveal the player, and verify the source tab remains active.

## Player

- Direct OPhim HLS playback uses native HTML5 HLS first where supported. `HlsVideo.tsx` dynamically imports the light hls.js build only for the explicit MSE fallback path.
- M3U8/HLS chunking is delegated to upstream playlist segments; do not proxy, re-chunk, download, transcode, or store third-party video segments through the Cloudflare Worker.
- HLS performance tuning belongs in the client player: conservative default buffer, good-network aggressive buffer cap, retry settings, lazy loading, native HLS fallback, and fatal error recovery.
- Default HLS buffer target should remain 60 seconds. Aggressive mode may target 180 seconds with a 300-second max cap only on good connections; 5-minute buffering is not a universal default.
- Embed playback uses `IframePlayerFacade.tsx`; unified source selection logic is in `src/pages/movie/[slug].astro` and `components/MoviePlayer.tsx`.
- Preserve mobile/embed fallback behavior unless the task targets player selection.

## SEO And Public Files

- Core page metadata is in `BaseLayout.astro`; movie pages pass video metadata props.
- Robots and sitemap files live under `public/`.
- Need verification: sitemap update/generation process is not evident from inspected files.

## 2026-06-15 Image Resolution & Feature Realignment

- **Oversized Origin Fallbacks**: Relaxed `originFallbackTooLarge` check in `src/pages/api/image.ts` to use `hardOriginBytes` (8MB) rather than `maxOriginFallbackBytes` (700KB/1.2MB). This prevents the image proxy from rejecting large posters (often 1MB-7MB) returned by OPhim, which was causing the "no-image" production issue on free Cloudflare plans that do not support active image resizing/transformation.
- **Client-Side Original Fallback**: Added `data-original-src` support to `src/layouts/BaseLayout.astro`, `components/MovieCard.tsx`, `components/HeroSlider.tsx`, and `src/pages/movie/[slug].astro`. If the worker proxy fails to cache/retrieve both the poster and the thumbnail, the browser attempts to fetch the original unproxied CDN URL directly before showing the placeholder.
- **OPhim Hostname Normalization**: Updated `normalizePosterUrl` in `lib/movie-images.ts` to automatically rewrite alternative/legacy subdomains (such as `img.ophim.cc` and `img.ophim.co`) to `img.ophim.live`. This keeps requests consistent with the allowed host list and avoids mirror validation errors.
- **Project 1 vs Project 2 Boundary**:
  - *Project 1 (FilmBluesia)*: Runs on Cloudflare Workers/Pages. Uses Cloudflare-native APIs: Cache API, KV-compatible metadata storage, and static asset routing via `ASSETS` binding. It does NOT use Node-only filesystem persistence. As of 2026-06-15, it DOES share the `img.bluesia.net` external image cache contract with Project 2 to deduplicate VPS image caching, signing URLs using Web Crypto API (`crypto.subtle`) at the data fetching layer.
  - *Project 2*: Vercel/Next.js external image cache logic. Keep the boundaries clear for runtime APIs (Node vs Cloudflare), but image URL contracts are now shared.
- **Navigation and Tab Persistence**: Navigation flow persists category context (e.g. `phim-le`, `phim-bo`) via the `returnTo` query parameter rather than hash fragments. The back button on `/watch` points to `/movie/[slug]?returnTo=<encoded-list-url>` and detail page back points to the preserved `returnTo` list path. BottomNav tab active state resolves from `returnTo`, fallback pathname, or metadata.

## Verification

- Run `npm run build` after code or config changes when reasonable.
- There are currently no lint/test scripts in `package.json`.
- For cache/runtime changes, also review `docs/CLOUDFLARE_CACHE.md` for documentation drift.
- Do not fix unrelated worktree changes unless they directly block verification.

## UI Ratings

- Poster card UI displays IMDb rating only; TMDB rating remains fetched/preserved for metadata and internal use.
