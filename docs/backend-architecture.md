# Blueflare backend architecture

## Current decision

The repository runs a self-hosted Next.js frontend and a Dockerized Blueflare
origin on the VPS. Caddy is the public TLS/reverse-proxy boundary. Cloudflare
provides normal DNS/proxy/CDN caching only; there is no frontend Worker.

    Browser
      -> Cloudflare proxy/CDN
      -> Caddy
      -> Next.js frontend :3100
      -> Blueflare API :3200
      -> Valkey final-response cache
      -> PostgreSQL canonical catalog
      -> background provider sync

## Ownership

| Surface | Owner |
| --- | --- |
| Pages, routing, server render cache | Next.js frontend container |
| Home/list/detail/search ViewModels | Blueflare API |
| Provider sync and health | backend worker |
| TMDB identity ranking (AI match, promotion) | backend worker (own loop) |
| Canonical identity and provenance | PostgreSQL |
| Final JSON response cache | Valkey |
| m/d image variants and signing | backend API |
| Public TLS and reverse proxy | Caddy + Cloudflare |
| Video transport | Provider; never Blueflare |

## Cache behavior

- The API returns fresh Valkey entries without PostgreSQL work.
- Stale entries are served during the configured stale window when refresh fails.
- Successful sync increments the catalog version and precomputes home data.
- Next server helpers use tagged render-cache entries; the protected internal
  revalidation route invalidates only affected tags.
- Search is request-specific and is not put in the public render cache.
- `GET /api/cards?slugs=` is cached 60s in Valkey, keyed only by the sorted slug list.
- `GET /api/movies/:slug/reviews` is cached 60s in Valkey, keyed `reviews:<slug>:<page>:<limit>` only.

## Accounts

User accounts, sessions and the last watched episode per title (`user_history`) live in PostgreSQL (migrations 020, 021). The TMDB identity audit/undo log `tmdb_identity_changes` (migration 030) is irreplaceable state in the same dump; `ai_quota_ledger` (031) is disposable.
`auth.js` handles password hashing and sessions; `meApi.js` serves `/api/auth/*`
and `/api/me/*`, never response-cached (Valkey is used only for auth rate-limit counters). Browsers reach them only through the
Next proxy on `phim.bluesia.net` (`bf_session` cookie, HttpOnly, SameSite=Lax);
Caddy returns 404 for these paths on `img.bluesia.net`, and refuses `/api/auth/*` on
`phim.bluesia.net` with 403 unless the peer is a Cloudflare IP (`@authdirect`).

Hardening (PLAN-008): `HashGate` in `auth.js` caps concurrent scrypt at
`AUTH_HASH_CONCURRENCY` (2) with a queue of `AUTH_HASH_QUEUE` (16) and a 3 s queue
wait; beyond that the API answers 503 `{error:"busy"}` + `Retry-After: 2`.
scrypt shares the libuv threadpool with image I/O and sharp, so `api` runs with
`UV_THREADPOOL_SIZE=8`. Rate-limit buckets (429 `rate_limited` + `Retry-After`):

| Bucket | Limit |
| --- | --- |
| register per IP | 5/h |
| register global (`AUTH_REGISTER_GLOBAL_PER_HOUR`) | 300/h |
| login per IP | 30/15 min |
| login per IP+email | 10/15 min |
| login per email | 20/h, failures only |

Counters live in Valkey (`auth:rl:<bucket>:<sha256>`); on error or a reply slower
than 100 ms `authLimits.js` falls back to in-memory counters (fail-open, logged)
and skips Valkey for 5 s. Consecutive login failures lock the IP+email pair with
429 instead of sleeping. Known limitation: an attacker who knows an email can lock
that account out of login for up to an hour.

## API contract: people/credits

`GET /api/movie/:slug` gains a `movie.people` field: `{ cast: [], directors: [] }`,
each entry `{ name, slug, character, photo }`. It is populated only when the
canonical row carries a **verified** TMDB identity (`tmdb_id` + `tmdb_media_type`,
not the looser recommendation/image-fallback ids). That identity may come from the
provider, from the worker's AI match pass (an OpenRouter model ranks real TMDB candidates, an
independent gate decides, source `inferred`), or from promotion of a cast-verified
match; `tmdbIdentity.js` assigns, merges into the row already holding it, or promotes,
and every change is logged in `tmdb_identity_changes` and can be undone; most of the catalog has empty
arrays here, and the existing plain-text `actor`/`director` fields stay populated
either way.

`GET /api/person/:slug` — paginated filmography for one TMDB person.
- Query params: `page` (1-based, default 1), `role` (`cast` | `director` | `all`,
  default `all`).
- Envelope matches the list endpoints: `{ status: 'success', data: { titlePage,
  person: { name, slug, photo }, items: [...card], params: { pagination: {
  totalItems, totalItemsPerPage, currentPage, totalPages } } } }`.
- 404 (not the list endpoints' empty-array shape) when the slug has no matching
  person row.
- Cache key is scoped to `slug:role:page` only — never `returnTo`, cookies, or
  user agent — consistent with every other cached route.

## API contract: reviews

`GET /api/movie/:slug` gains `movie.reviews` (the first 5 reviews) and
`movie.reviewCount` (total stored). Both are empty/0 when the title has no
TMDB reviews.

`GET /api/movies/:slug/reviews` — one page of TMDB user reviews.
- Query params: `page` (1-based, default 1), `limit` (default 10, max 20).
- Response (no `status`/`data` envelope): `{ reviews: [...], reviewCount, page,
  limit, totalPages }`; each review is `{ id, author, rating (0-10 or null),
  content (plain text, English), contentVi (plain text Vietnamese machine
  translation, or null when none exists for the current `content`), createdAt,
  url (themoviedb.org or null), hasSpoiler }`. `hasSpoiler` and the ordering
  score are computed on the English `content`. The worker fills `contentVi`
  asynchronously (OpenRouter model rotation from `openrouter.js`, gtx fallback; any can be blocked), so clients must
  treat it as optional and fall back to `content`.
- 404 `{ error: 'Movie not found' }` for an unknown slug.
- Order: `hasSpoiler` first, then score band, then a shuffle stable per slug and
  UTC day, so all pages of one run agree. Computed per request from stored rows;
  TMDB is never called here.
- Cache key is `reviews:<slug>:<page>:<limit>` only, TTL 60s; never `returnTo`,
  cookies or user agent. The worker drops pages 1-4 for limits 5 and 10 when a
  title's reviews change.
- Content and `contentVi` are plain text; clients must render them as text, not HTML.

## Deployment boundary

Compose binds the frontend to `127.0.0.1:3100` and the API to `127.0.0.1:3200`;
PostgreSQL and Valkey remain private to the Compose network. `infra/`
contains the compose file, the Caddy site blocks (inside `infra/scripts/bootstrap-vps.sh`) and the optional normal Cloudflare cache rules.
