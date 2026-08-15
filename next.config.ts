import type { NextConfig } from "next";

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
      {
        source: "/(robots.txt|sitemap.xml|sitemap-index.xml)",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, s-maxage=3600" }]
      },
    ];
  }
};

export default nextConfig;
