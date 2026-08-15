# Blueflare UI v2 — Connected Design QA

Date: 2026-08-14

## Result

The rebuilt UI now renders against the live Blueflare Docker catalog. The
populated home, movie-detail shell, navigation, search suggestions, rails,
episode replacement navigation, and two-step player flow passed the connected
checks below.

`final result: pass`

The frontend cutover is now represented by the Next.js VPS site block in
`backend/deploy/phim.bluesia.net.caddy`; production persistence and Caddy reload
remain an operator action. The scoped Cloudflare cache rule is optional and
requires a token with `Zone > Cache Rules > Edit`.

## Comparison target and evidence

- Source reference: `/home/ubuntu/.codex/attachments/665b4979-665e-4555-8b68-bff7886cf877/codex-clipboard-3ebc2eef-390a-4e74-8362-f41e9fc6e130.png`
- Equal-pixel comparison: `docs/design-qa-captures/reference-vs-home-connected.webp`
- Reference viewport: `docs/design-qa-captures/home-connected-740x411.png`
- Mobile: `docs/design-qa-captures/home-connected-390x844.png`
- Desktop: `docs/design-qa-captures/home-connected-1440x1000.png`
- Movie detail: `docs/design-qa-captures/detail-connected-1440x1000.png`

The supplied screenshot defines compact navigation, low chrome, dense
landscape shelves, and horizontal continuation. The written mandate has higher
structural priority and explicitly requires a full-bleed cinematic hero, so the
implementation intentionally does not pixel-clone the reference's list-only
first viewport.

## Visual findings

- The connected hero uses a real signed backdrop, legible left-aligned title
  block, restrained metadata, and direct primary/secondary actions.
- Desktop rails preserve the reference's dense landscape rhythm and continue
  beyond the viewport. Mobile shows approximately two cards plus a continuation
  cue without horizontal page overflow.
- The detail page reuses the same cinematic hierarchy, keeps the player action
  prominent, and places episode/server controls below it without returning to
  the rejected panel-heavy visual language.
- Black, white, silver, graphite, and `#e50914` remain the active palette. No
  v1 steel-blue hierarchy or persistent mobile bottom navigation remains.
- Inter/Roboto/system UI remains the intentional fallback because no licensed
  Netflix Sans asset was supplied.

No actionable P0/P1/P2 visual issue remains in the captured states.

## Browser interaction checks

The pre-cutover static QA captured the shared visual shell and interaction
contracts; current production routing is validated separately through Next.js
SSR smoke tests. Connected headless Chrome checks produced these results:

- The pre-cutover static capture contained the first hero title, signed `/i/d/`
  backdrop, `loading="eager"`, `fetchpriority="high"`, and the first rail before
  hydration. Compressed initial HTML is approximately 23 KB with one eager image.
- Fresh-profile local production preview measured LCP 748 ms, CLS 0, DOMContentLoaded
  146 ms, and load 705 ms. The interaction observer recorded no event over 16 ms.
- The Hero #1 response completed at 688 ms and decoded at the canonical 1280×720.
- Home rendered 74 movie links from the live catalog.
- Selecting a home movie preserved `returnTo=/`.
- Three episode selections used replacement navigation; one Back returned
  directly to `/` instead of traversing episode history.
- The player started with zero iframes. `Xem phim` revealed only the facade;
  the separate facade Play interaction then mounted one provider iframe.
- The mounted iframe host was `player.phimapi.com`; Blueflare did not proxy
  video bytes.
- Mobile menu opened, closed on Escape, and exposed all primary/library links.
- Search opened with the input focused; `nhan` returned the real “Nhân Ngư”
  suggestion and the all-results route.
- The first desktop rail moved from `scrollLeft=0` to `1069` after its right
  control was activated.

## Backend and edge evidence

- Public `/api/home-data`: HTTP 200 and `X-Blueflare-Cache: VALKEY-HIT`.
- Signed `/i/d/` image: WebP, one-year immutable cache header, and
  `CF-Cache-Status: HIT`.
- Public JSON currently reports `CF-Cache-Status: DYNAMIC`; the attempted
  Rulesets API write was rejected with Cloudflare authentication error `10000`.
  The exact rule payload is committed at
  `backend/deploy/cloudflare-cache-rule.json`.
- Caddy currently serves `img.bluesia.net` successfully from its active config;
  persistence still requires the privileged host-file edit documented in
  `backend/README.md`.
