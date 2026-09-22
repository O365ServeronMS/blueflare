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

## API contract: people/credits

`GET /api/movie/:slug` gains a `movie.people` field: `{ cast: [], directors: [] }`,
each entry `{ name, slug, character, photo }`. It is populated only when the
canonical row carries a **verified** TMDB identity (`tmdb_id` + `tmdb_media_type`,
not the looser recommendation/image-fallback ids); most of the catalog has empty
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

## Deployment boundary

Compose binds the frontend to `127.0.0.1:3100` and the API to `127.0.0.1:3200`;
PostgreSQL and Valkey remain private to the Compose network. `backend/deploy/`
contains the Caddy site blocks and the optional normal Cloudflare cache rule.
