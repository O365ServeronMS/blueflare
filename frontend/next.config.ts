import type { NextConfig } from "next";

const PUBLIC_DOCUMENT_SOURCES = ["/", "/list/:path*", "/movie/:slug", "/person/:slug"];

const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/healthz",
        headers: [{ key: "Cache-Control", value: "no-store" }]
      },
      {
        // Prevent Cloudflare Web Analytics/RUM from rewriting HTML responses.
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [{
          key: "Cache-Control",
          value: "private, no-store, max-age=0, must-revalidate, no-transform"
        }]
      },
      ...PUBLIC_DOCUMENT_SOURCES.map((source) => ({
        source,
        // Full HTML documents only: RSC and prefetch variants share the URL but
        // not the representation, and a shared cache must never mix them.
        missing: [
          { type: "header" as const, key: "rsc" },
          { type: "header" as const, key: "next-router-prefetch" },
          { type: "query" as const, key: "_rsc" }
        ],
        headers: [{
          key: "Cache-Control",
          value: "public, max-age=60, s-maxage=600, no-transform"
        }]
      })),
      {
        source: "/(robots.txt|sitemap.xml|sitemap-index.xml)",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, s-maxage=3600" }]
      },
    ];
  }
};

export default nextConfig;
