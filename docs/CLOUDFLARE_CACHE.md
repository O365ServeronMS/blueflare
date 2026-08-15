# Cloudflare cache policy

> **Current runtime:** Cloudflare is a normal proxy/CDN in front of Caddy and
> the VPS-hosted Next.js frontend. No Worker, KV binding, Pages Function, or
> Cloudflare-side HTML rendering is deployed.

## Cache boundaries

- `/_next/static/*`: immutable, fingerprinted assets; use the scoped cache rule
  in `backend/deploy/cloudflare-frontend-static-rule.json` (one year).
- Public HTML: cache only after measuring route safety and excluding RSC, search,
  private/local-state routes, and query variants that change representation.
- `/i/m/*` and `/i/d/*`: owned and signed by `img.bluesia.net`; retain its
  origin TTL and shared two-variant cache contract.
- API JSON: cache according to Blueflare response headers and Valkey state; do
  not cache health or internal revalidation requests.
- Search and user-local pages should remain bypass/no-store where applicable.

Verify with repeated requests and inspect `CF-Cache-Status`, `Age`, and the
origin `x-blueflare-cache` signal. Report HIT rates separately for static assets,
images, public HTML, and API JSON; never average private/search/video traffic
into a 95–99% claim.

Historical Worker/KV notes were removed from the active runbook.
