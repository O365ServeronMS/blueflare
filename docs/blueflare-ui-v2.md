# Blueflare UI v2

## Product direction

Blueflare is a premium cinematic discovery surface. Content is the interface, pure black is the stage, artwork supplies nearly all color, and `#e4312a` is reserved for the brand, active indicators, and primary playback actions. The visual language is dense, compact, and confident rather than decorative.

## Token model

- Canvas: `#000000`.
- Primary text: `#ffffff`; secondary text: `#b3b3b3`; quiet text: `#808080`.
- Surfaces: `#2d2d2d` and `#414141`, used only where controls require separation.
- Accent: `#e4312a`, restricted to brand, active state, and primary playback urgency.
- Typography: Inter, Roboto, system UI. One family, 400/500/700/900.
- Spacing: 4px base scale from the root token source.
- Radius: 4px controls, 8px compact media, 16px only for large feature surfaces.
- Elevation: image overlap, scale, opacity, and surface contrast; no traditional card shadows.

## Component hierarchy

```text
BaseLayout
├── GlobalNav
│   ├── Brand
│   ├── DesktopLinks
│   ├── SearchOverlay
│   └── MobileMenu
├── RouteContent
│   ├── Home
│   │   ├── CinematicHero
│   │   └── ContentRail[]
│   │       ├── RailControls
│   │       └── MediaCard[]
│   ├── CatalogList
│   │   ├── PageHeading
│   │   ├── FilterStrip
│   │   ├── MediaGrid
│   │   └── Pagination
│   ├── MovieDetail
│   │   ├── DetailHero
│   │   ├── MoviePlayer
│   │   ├── EpisodeSelector
│   │   ├── EditorialMetadata
│   │   └── RelatedRail
│   └── Search / LocalLibrary / Settings / Error
└── GlobalFooter
```

## Home architecture

The fixed navigation begins transparent and becomes near-black after scroll. The hero occupies roughly 74–82vh on desktop and 64–72vh on mobile, with a full-bleed backdrop, left and bottom fades, a short metadata row, two actions, and a restrained synopsis. The first rail overlaps the hero fade slightly. All sections after the hero are horizontal native-scroll rails, not fixed grids. Desktop exposes about five to six landscape cards; mobile exposes roughly 2.2 cards to signal continuation.

## Media behavior

- Home rails use landscape `poster_url` backdrops in 16:9 frames when available.
- Catalog, search, favorites, and history use 2:3 `thumb_url` posters.
- Cards show minimal status; titles are visible where orientation and context require them.
- Desktop hover scales inside an overlay layer without changing document flow; keyboard focus reveals the same treatment.
- Rail arrows use native `scrollBy`; touch remains native horizontal swipe.
- Every media frame has an intrinsic ratio and a controlled fallback.

## Detail and playback

The detail route opens on a full-width backdrop that fades into black. Title, critical metadata, overview, and the Play action remain above the fold. The player expands below the hero and keeps the existing two-step no-autoplay contract. Episodes are grouped by server in compact horizontal selectors instead of a wall of bordered cards. Credits and secondary data follow as quiet editorial copy. Recommendations reuse the home rail.

## Search and lists

Search can be opened from the global navigation and keeps the existing dedicated route. Suggestions are poster-led and keyboard accessible. Empty search states link back into discovery. Lists use a wide responsive poster grid and compact horizontal filters. Pagination retains the repository’s strict compact window.

## Responsive rules

| Width | Navigation | Hero | Rails / grid |
|---|---|---|---|
| 360–430 | wordmark, search, menu | shorter crop, 2–3 lines copy, 44px controls | ~2.2 landscape rail cards; 2 poster columns |
| 768 | compact desktop transition | 70vh | ~3.4 landscape cards; 4 poster columns |
| 1024 | full desktop links | 76vh | ~4.4 landscape cards; 5 poster columns |
| 1280–1440 | full navigation | 78vh | ~5.5 landscape cards; 6 poster columns |
| 1920 | bounded text, full-bleed art | 80vh | ~6.5 landscape cards; 7 poster columns |

Horizontal page gutters are fluid from 16px mobile to 4vw desktop. The content canvas is full-width with a 1920px editorial cap; it is not constrained to the old 720px shell.

## Interaction and motion

- Feedback: 140–180ms.
- Media emphasis: 180–240ms.
- Hero crossfade: 500–700ms, with only the active image requested eagerly.
- Reduced motion disables automatic hero rotation and scale transitions.
- Focus rings are visible white/red outlines with offset; controls remain at least 44px on touch.

## Accessibility

- Semantic navigation, headings, buttons, and lists.
- Named rail regions and arrow controls.
- Keyboard rail scrolling, search, menu, player, and episode selection.
- Descriptive poster alt text; decorative backdrops use empty alt text.
- No color-only state communication; active navigation and episodes use text/ARIA state too.
- Contrast meets dark-canvas legibility requirements.

## Image and LCP strategy

- Use only the `i/m` and `i/d` URLs the catalog API emits; never create new variants, and never sign or re-key an image URL client-side.
- Build-time Hero #1: present in initial HTML with `loading="eager"`, `fetchpriority="high"`, and `decoding="async"`.
- Other hero candidates are not mounted as images until active.
- All cards and recommendations: `loading="lazy"`, `decoding="async"`.
- Preserve 2:3 and 16:9 aspect ratios to avoid layout shift.
- Do not add broad preload, route prefetch, video preload, or a carousel dependency.
- The static build serializes only Hero #1 and the first rail; hydration refreshes the full cached HomeViewModel and reveals later rails progressively.

## Performance budget

- No new UI framework or carousel package.
- Existing icon package only; tree-shaken imports.
- Initial interactive JavaScript remains limited to the global nav and current route island.
- One eager image maximum per screen.
- Player iframe mounts only after the explicit second Play interaction; direct video preload remains `metadata`.
- Target LCP < 2.5s, CLS < 0.1, INP < 200ms on the deployed site, to be measured where the catalog API is reachable.

## Migration plan

1. Replace the HBO-oriented global tokens with root-source Netflix-red semantic aliases.
2. Remove the 720px shell and bottom navigation; introduce global responsive navigation and footer.
3. Rebuild media cards and rails, then make the homepage the reference implementation.
4. Recompose detail/player/episodes without touching playback source selection.
5. Rebuild list, search, local library, settings, and 404 with the same primitives.
6. Remove old blue-token usage and legacy visual components after route migration.
7. Build and run visual/interaction QA at the required responsive widths.
