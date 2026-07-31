# FilmBluesia

A Vietnamese movie streaming catalog at **[film.bluesia.net](https://film.bluesia.net)** — browse, search, and watch movies with a fast, mobile-first interface.

---

## What it does

- **Browse & search** Vietnamese movie metadata served by the **`catalog-api`** service (which proxies OPhim and enriches it with TMDB)
- **Stream** via embedded players or direct HLS playback, device-aware (iOS vs Android/Desktop)
- **Remember** your favorites and watch history, stored locally in your browser
- **Load fast** — the site is prerendered static HTML on Cloudflare's edge; posters come pre-signed from a shared image CDN

---

## Architecture in one line

The frontend is **static assets only** — no server, no Cloudflare Worker, no SSR. Everything that needs CPU (proxying OPhim, TMDB enrichment, HMAC-signing images, caching) runs on a separate **VPS `catalog-api`** at `img.bluesia.net/api/*`. The React islands fetch those payloads **client-side** in the browser.

---

## Stack (for the curious)

| What | How |
|---|---|
| Pages & routing | [Astro 7](https://astro.build) — `output: "static"`, prerendered HTML (no SSR) |
| Interactive bits | React 19 (islands only) |
| Styling | Tailwind CSS 4 |
| Hosting | Cloudflare **static assets** (no Worker, no KV) |
| Catalog data · metadata · images | VPS `catalog-api` at `img.bluesia.net/api/*` (client-side fetch) |
| Taxonomy lists | `ophim1.com/v1/api/{the-loai,quoc-gia}` (client-side) |
| Images | `img.bluesia.net` — pre-signed by `catalog-api` (frontend never signs) |
| Video | hls.js (direct HLS) + Vidsrc/VSEmbed embed |
| User state | browser `localStorage` (favorites / history) |

---

## Run it locally

```bash
npm install
npm run dev        # → http://localhost:4321
```

```bash
npm run build      # production build → dist/ (static assets, no _worker.js)
npm run preview    # build + serve via Wrangler (mirrors the Cloudflare static host)
```

> `catalog-api` allowlists `localhost` and every `*.bluesia.net` origin, so catalog data loads fine in `dev`/`preview`.

---

## Deploy

Static assets, zero-Worker:

```bash
git push origin main   # Cloudflare auto-deploys the static assets
```

…or deploy manually when you mean it:

```bash
npm run deploy         # astro build + wrangler deploy
```

Production must run on a `*.bluesia.net` host for `catalog-api` CORS to apply.

---

## Project layout

```
src/pages/       # Routes: /, /list/[type], /detail (movie shell), /search, /favorites, /history, /settings
components/      # UI: MovieCard, HeroSlider, MoviePlayer, BottomNav, MovieDetailIsland, …
lib/             # Logic: catalog-api client, image URLs, types, playback, navigation
public/          # _redirects (/movie/* → /detail shell), _headers, static assets
docs/            # Architecture notes (start with DECISIONS.md)
```

> `/movie/<slug>` has no per-slug page — it's an unbounded route. `public/_redirects` rewrites `/movie/*` to the static `/detail/` shell (HTTP 200), and `MovieDetailIsland` reads the slug from the URL and fetches detail client-side.

---

## For developers

Full architectural decisions, image-URL rules, and anti-regression guidelines live in [`docs/DECISIONS.md`](docs/DECISIONS.md) and [`CLAUDE.md`](CLAUDE.md). Read them before touching image URLs, navigation, or playback.

The only automated check is the build:

```bash
npm run build    # must pass after every change
```
