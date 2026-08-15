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
        source: "/(robots.txt|sitemap.xml|sitemap-index.xml)",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, s-maxage=3600" }]
      },
    ];
  }
};

export default nextConfig;
