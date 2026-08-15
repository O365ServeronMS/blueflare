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

## Deployment boundary

Compose binds the frontend to `127.0.0.1:3100` and the API to `127.0.0.1:3200`;
PostgreSQL and Valkey remain private to the Compose network. `backend/deploy/`
contains the Caddy site blocks and the optional normal Cloudflare cache rule.
