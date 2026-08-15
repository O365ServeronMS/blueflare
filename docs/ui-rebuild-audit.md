# Blueflare UI Rebuild Audit

Date: 2026-08-14

## Scope and source resolution

This audit treats the root `DESIGN.md`, `tokens.json`, `variables.css`, and `theme.css` as the visual source of truth, in that order. The older HBO Max-oriented files under `docs/` describe the rejected v1 visual implementation and are useful only as audit evidence. `CLAUDE.md` remains authoritative for runtime architecture: Next.js is rendered by the VPS frontend container, while this repository also owns the Blueflare Docker backend in `backend/` (NguonC/KKPhim sync, PostgreSQL canonicalization, Valkey response caching, signed images, and precomputed ViewModels).

The supplied 740 × 411 reference image establishes the density target: compact global navigation, near-zero chrome, section labels close to content, wide landscape media tiles, and horizontal continuation beyond the viewport. It is a composition reference, not a request to copy Netflix branding or artwork.

## Current-state evidence

- `docs/current-ui-captures/home-desktop-before.png` — 1440 × 1000.
- `docs/current-ui-captures/home-mobile-before.png` — 390 × 844.
- `docs/current-ui-captures/list-desktop-before.png` — 1440 × 1000.
- `docs/current-ui-captures/search-mobile-before.png` — 390 × 844.

The catalog host could not be resolved from the implementation environment during capture, so the screenshots document shell, error, navigation, width, and responsive behavior. Data-bearing behavior was audited from `lib/catalog.ts`, shared types, and every consuming island.

## What is rejected

- The 720px centered app shell. It reads as a phone app enlarged on desktop and prevents an infinite-shelf composition.
- HBO-style blue interaction tokens. The new hierarchy uses pure black, white, silver, graphite, and a restrained `#e50914` accent.
- The portrait-card carousel used as the home hero. The new hero is a full-bleed backdrop composition with left-aligned content.
- Grid-first homepage sections. The new homepage uses horizontal rails as its primary browsing primitive.
- Persistent mobile bottom navigation. The new mobile composition uses a compact top bar with search and an accessible menu.
- Rounded panels, borders, pills, and shadows as default hierarchy devices.
- Metadata-heavy poster cards and card text blocks that make the catalog feel like a database.

## Functionality that must survive

- Next.js App Router routes, direct `/movie/[slug]` rendering, and pagination behavior.
- Browser-side catalog fetches, normalization, caching, search debounce, list filters, and strict compact pagination.
- `returnTo` category context, contextual movie links, episode replace-navigation, and back behavior.
- Favorites and history stored in `localStorage`.
- Desktop/Android iframe-first playback, iOS native-HLS-first playback, and dynamic `hls.js/dist/hls.light.js` fallback.
- Explicit two-step playback: revealing the player does not load or autoplay the iframe; the facade requires a separate Play interaction.
- Pre-signed `i/m` poster and `i/d` backdrop image contract, fallback chain, aspect-ratio stability, and TMDB attribution.
- Adaptive prefetch restrictions and the absence of broad media or route preloads.

## Screen classification

| Screen | Classification | Surviving behavior | Rebuild target |
|---|---|---|---|
| Home | REBUILD | home fetch, deferred sections, movie links | full-bleed hero plus dense landscape rails |
| Movie detail/playback | REBUILD | slug resolution, source priority, episode state, recommendations | backdrop-led detail, player-first action, compact episodes, related rail |
| Watch | KEEP-LOGIC-ONLY | legacy redirect | no independent visual screen |
| Search | REBUILD | debounce, URL sync, results, pagination | nav-level search overlay/page with cinematic results grid |
| Lists | REBUILD | type routes, filters, pagination | wide catalog canvas with compact filters and poster grid |
| Genre/country | KEEP-LOGIC-ONLY | dedicated catalog endpoints | represented through list filters until dedicated routes exist |
| Favorites/history | REBUILD | local persistence | lightweight library pages using the new media grid |
| Settings | REBUILD | deployment/source/TMDB disclosures | quiet editorial information page |
| Errors/empty states | REBUILD | retry/context messages | low-chrome recovery states with useful next routes |
| Mobile navigation | REBUILD | active route/context semantics | compact logo/search/menu header; no persistent bottom rail |
| 404 | REBUILD | static fallback requirement | cinematic recovery page added as `/404.html` |

## Component classification

| Existing component | Classification | Notes |
|---|---|---|
| `HomeIsland` | KEEP-LOGIC-ONLY + REBUILD | preserve fetch/defer; replace composition |
| `HeroSlider` | REBUILD | preserve optional rotation/preferences; replace poster stack with backdrop hero |
| `SectionRow` | REBUILD | becomes the reusable content-rail primitive |
| `MovieCard` | REBUILD | keep image/URL/fallback logic; add landscape/poster presentations |
| `TopBar` | DELETE | superseded by global navigation |
| `BottomNav` | DELETE VISUAL | preserve context rules through global nav and link utilities |
| `SearchSuggest` | REBUILD | preserve debounce and results behavior |
| `SearchResults` | REBUILD | preserve URL state and pagination |
| `ListIsland` | KEEP-LOGIC-ONLY + REBUILD | preserve filters/load/pagination |
| `Pagination` | REBUILD | preserve exact compact-window algorithm |
| `MovieDetailIsland` | KEEP-LOGIC-ONLY + REBUILD | preserve data/player/navigation; replace full view |
| `MoviePlayer`, `IframePlayerFacade`, `HlsVideo` | KEEP-LOGIC-ONLY + REBUILD | playback ordering is immutable; restyle facade and shell |
| `LocalMovieActions`, `StoredMovieGrid`, `WatchRecorder` | KEEP-LOGIC-ONLY + REBUILD | preserve persistence/recording |
| `BaseLayout` | REBUILD | full-width shell, global nav, footer, existing scripts preserved |

## Primary risks and constraints

- The static build now reads the cached HomeViewModel and embeds Hero #1 plus the first rail in generated HTML. If the backend is unavailable during a release build, the guarded fetch falls back to the recovery shell; release verification must therefore retain the initial-HTML LCP assertion.
- The supplied root design source names Netflix Sans, but no licensed font asset exists. The implementation uses Inter/Roboto/system-ui fallbacks and does not bundle Netflix Sans.
- `img.bluesia.net` depends on a host Caddy site block. The route is live in Caddy's active configuration, but `/etc/caddy/Caddyfile` still needs a privileged write so it survives a Caddy restart.
