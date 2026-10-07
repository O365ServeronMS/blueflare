# Cloudflare cache policy

> **Current runtime:** Cloudflare is a normal proxy/CDN in front of Caddy and
> the VPS-hosted Next.js frontend. No Worker, KV binding, Pages Function, or
> Cloudflare-side HTML rendering is deployed.

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
- `/i/m/*` and `/i/d/*`: owned and signed by `img.bluesia.net`; retain its
  origin TTL and shared two-variant cache contract.
- API JSON: cache according to Blueflare response headers and Valkey state; do
  not cache health or internal revalidation requests.
- Account routes (`/api/auth/*`, `/api/me/*`) are excluded: 404 on the img host, `no-store` on the phim host. `GET /api/cards?slugs=` is public and cacheable (60s). `GET /api/movies/:slug/reviews` is public too: 200 sends `public, max-age=60, stale-while-revalidate=<stale window>, stale-if-error=<stale window>` plus `x-blueflare-cache`; an unknown slug 404s with `public, max-age=30, stale-while-revalidate=60`.
- Search and user-local pages should remain bypass/no-store where applicable.

Verify with repeated requests and inspect `CF-Cache-Status`, `Age`, and the
origin `x-blueflare-cache` signal. Report HIT rates separately for static assets,
images, public HTML, and API JSON; never average private/search/video traffic
into a 95–99% claim.

Historical Worker/KV notes were removed from the active runbook.

## Auth hardening (PLAN-008 phase 3)

Steve applies these by hand; agents never touch Cloudflare or the live Caddyfile.

Rate limit and bot protection (dashboard):

1. Security > WAF > Rate limiting rules > Create rule, name `blueflare_auth_ratelimit`.
2. Expression: copy `expression` from `infra/cloudflare/cloudflare-auth-ratelimit-rule.json`.
3. Counting: IP, 10 requests per 60 s, action Block, duration 600 s.
4. If the free plan rejects it, use ip.src only and the shortest period/timeout it allows (one rule max).
5. Security > Bots > turn on Bot Fight Mode.

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

Recommended (needs sudo, not done by us): firewall port 443 to Cloudflare ranges only, so nothing reaches the origin directly.
