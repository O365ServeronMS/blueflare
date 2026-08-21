import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { GlobalNav } from "@/components/GlobalNav";
import { ImageFallbackHandler } from "@/src/app/image-fallback-handler";
import { readFrontendFeatures } from "@/lib/features";
import "@/src/styles/globals.css";

// Netflix Sans stand-in named by DESIGN.md. Self-hosted by next/font, so the
// real weight 900 is available — without it the browser synthesizes a faux
// bold from the system fallback and heavy type (the Top-10 numerals) is wrong.
const inter = Inter({
  subsets: ["latin", "vietnamese"],
  variable: "--font-inter",
  display: "swap"
});

// GlobalNav reads usePathname() to render the active tab correctly on first
// paint (no client-only flash). Every route already forces per-request
// rendering via connection(), so there's no static shell here for instant
// navigation to protect — this just opts the layout out of that validation.
export const instant = false;

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
  const features = readFrontendFeatures();
  return (
    <html lang="vi" data-scroll-behavior="smooth" className={inter.variable}>
      <body className="min-h-screen bg-deep-space text-chalk-white antialiased">
        <GlobalNav featureSearch={features.searchSuggest} featureLocalLibrary={features.localLibrary} />
        <ImageFallbackHandler />
        <main>{children}</main>
      </body>
    </html>
  );
}
