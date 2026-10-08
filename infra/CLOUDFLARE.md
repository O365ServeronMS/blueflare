# Cloudflare cache policy

> **Current runtime:** Cloudflare is a normal proxy/CDN in front of Caddy and
> the VPS-hosted Next.js frontend. No Worker, KV binding, Pages Function, or
> Cloudflare-side HTML rendering is deployed.

## Contents

- [Cache boundaries](#cache-boundaries)
- [API routes at the edge](#api-routes-at-the-edge)
- [Cache rules in the repository](#cache-rules-in-the-repository)
- [Auth hardening](#auth-hardening)
- [Caddy `@authdirect` rule](#caddy-authdirect-rule)

## Cache boundaries

- `/_next/static/*`: immutable, fingerprinted assets; use the scoped cache rule
  in `infra/cloudflare/cloudflare-frontend-static-rule.json` (one year).
- Public HTML (`/`, `/list/*`, `/movie/*`, `/person/*`): the origin decides. `next.config.ts` sends
  `public, max-age=60, s-maxage=600` (10 min at the edge, 60 s in the browser) for full documents only;
  requests carrying `RSC`/`Next-Router-Prefetch` headers or a `_rsc` query keep `no-store`, as do search,
  login/signup, favorites/history and `/admin`. Cloudflare must honour the origin's Cache-Control for
  these paths (a Cache Rule "eligible for cache, use origin TTL"); with plain Standard cache level HTML is
  never stored and `CF-Cache-Status` stays `DYNAMIC`. After a sync the edge copy can lag by up to
  10 minutes: Next tags are expired at the origin immediately, but the edge is not purged.
- `/i/m/*` and `/i/d/*`: owned by `img.bluesia.net`, path-only and keyed by
  `image_assets.id` (`/i/{m,d}/<image_assets.id>.webp`); retain its origin TTL and
  shared two-variant cache contract (rule: `infra/cloudflare/cloudflare-image-cache-rule.json`).
- API JSON: cache according to Blueflare response headers and Valkey state; do
  not cache health or internal revalidation requests.
- Account routes (`/api/auth/*`, `/api/me/*`) are excluded: 404 on the img host, `no-store` on the phim host. Details per route are in [API routes at the edge](#api-routes-at-the-edge).
- Search and user-local pages should remain bypass/no-store where applicable.

Verify with repeated requests and inspect `CF-Cache-Status`, `Age`, and the
origin `x-blueflare-cache` signal. Report HIT rates separately for static assets,
images, public HTML, and API JSON; never average private/search/video traffic
into a 95–99% claim.

Historical Worker/KV notes were removed from the active runbook.

## API routes at the edge

All on `img.bluesia.net`. `<stale>` is `responseCacheStaleSeconds` of the API.

| Route | Edge behaviour | Origin header |
| --- | --- | --- |
| `/api/auth/*`, `/api/me/*` | never cached; Caddy answers 404 on the img host, so they are reachable only through the Next proxy on `phim.bluesia.net` (`no-store` there) | `no-store` |
| `GET /api/cards?slugs=` | public, cacheable; Valkey TTL 60 s, key = sorted slug list only | 200: `public, max-age=60, stale-while-revalidate=<stale>, stale-if-error=<stale>` + `x-blueflare-cache` |
| `GET /api/movies/:slug/reviews` | public, cacheable; Valkey TTL 60 s | 200: same as above; unknown slug 404: `public, max-age=30, stale-while-revalidate=60` |
| `GET /api/person/:slug` | public, cacheable; Valkey TTL 1 h | 200: same as above; unknown slug 404: `public, max-age=30, stale-while-revalidate=60` |
| `GET /api/movie/:slug`, `/api/recommendations/:slug`, `/api/home-data`, `/api/list`, `/api/genre`, `/api/country`, `/api/categories`, `/api/countries`, `/api/search` | public from the origin's point of view; whether Cloudflare stores them depends on the cache rule (next section) | 200: same as above; `/api/movie/:slug` 404: `public, max-age=30, stale-while-revalidate=60` |
| `/api/health`, `/api/metrics`, `/healthz` | do not cache | `no-store` |

## Cache rules in the repository

| File | Matches | TTL |
| --- | --- | --- |
| `infra/cloudflare/cloudflare-frontend-static-rule.json` | `phim.bluesia.net` `/_next/static/*` | edge and browser one year |
| `infra/cloudflare/cloudflare-image-cache-rule.json` | `img.bluesia.net` `/i/*` (GET/HEAD) | edge and browser one year (the rule's `ref` is still `blueflare_signed_images`, a leftover name) |
| `infra/cloudflare/cloudflare-cache-rule.json` | `img.bluesia.net` catalog API allowlist: `/api/home-data`, `/api/list`, `/api/genre`, `/api/country`, `/api/categories`, `/api/countries`, `/api/movie/*`, `/api/recommendations/*` | edge 5 min, browser 60 s (overrides origin) |
| `infra/cloudflare/cloudflare-auth-ratelimit-rule.json` | `/api/auth/*` rate limit (see below) | n/a |

`cloudflare-cache-rule.json` does not list `/api/movies/:slug/reviews`,
`/api/person/:slug`, `/api/cards` or `/api/search`, so those are cached only by
Valkey and the browser, not by the Cloudflare edge. The rules are applied by hand,
so a change to a JSON file takes effect only after it is re-applied in Cloudflare.

## Auth hardening

Steve applies these by hand; agents never touch Cloudflare or the live Caddyfile.

Rate limit and bot protection (dashboard):

1. Security > WAF > Rate limiting rules > Create rule, name `blueflare_auth_ratelimit`.
2. Expression: copy `expression` from `infra/cloudflare/cloudflare-auth-ratelimit-rule.json`.
3. Counting: IP, 10 requests per 60 s, action Block, duration 600 s.
4. If the free plan rejects it, use ip.src only and the shortest period/timeout it allows (one rule max).
5. Security > Bots > turn on Bot Fight Mode.

Recommended (needs sudo, not done by us): firewall port 443 to Cloudflare ranges only, so nothing reaches the origin directly.

## Caddy `@authdirect` rule

Caddy: `inject_caddy_block` skips an existing block, so edit `/etc/caddy/Caddyfile` by hand.
In the `phim.bluesia.net` block, after `@internal_revalidate` and before `reverse_proxy`, add
(keep the ranges in sync with `CLOUDFLARE_RANGES` in `lib/account-proxy.ts`, and refresh from cloudflare.com/ips):

```caddy
@authdirect {
	path /api/auth/*
	not remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
}
respond @authdirect 403
```

Then `caddy validate` and reload yourself (needs sudo).
