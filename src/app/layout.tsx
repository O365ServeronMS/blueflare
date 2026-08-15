import type { Metadata } from "next";
import { GlobalNav } from "@/components/GlobalNav";
import { ImageFallbackHandler } from "@/src/app/image-fallback-handler";
import "@/src/styles/globals.css";

export const viewport = { themeColor: "#000000" };

export const metadata: Metadata = {
  metadataBase: new URL("https://phim.bluesia.net"),
  title: "Bluesia Cinema",
  description: "Góc nhỏ của người đam mê phim",
  applicationName: "Bluesia Cinema",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png"
  },
  manifest: "/manifest.webmanifest"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" data-scroll-behavior="smooth">
      <body className="min-h-screen bg-deep-space text-chalk-white antialiased">
        <GlobalNav />
        <ImageFallbackHandler />
        <main>{children}</main>
      </body>
    </html>
  );
}
