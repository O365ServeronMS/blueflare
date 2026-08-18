import type { Metadata } from "next";
import { Archivo, Inter } from "next/font/google";
import { GlobalNav } from "@/components/GlobalNav";
import { ImageFallbackHandler } from "@/src/app/image-fallback-handler";
import "@/src/styles/globals.css";

// Netflix Sans stand-in named by DESIGN.md. Self-hosted by next/font, so the
// real weight 900 is available — without it the browser synthesizes a faux
// bold from the system fallback and heavy type (the Top-10 numerals) is wrong.
const inter = Inter({
  subsets: ["latin", "vietnamese"],
  variable: "--font-inter",
  display: "swap"
});

// Display face for the Top-10 numerals only. Netflix Sans is "slightly
// condensed and geometric" (DESIGN.md) and Inter is neither, which left the
// numerals reading too wide. Archivo is a geometric grotesque carrying a width
// axis, so the numerals can be narrowed to match. Latin subset only — this is
// used for digits and nothing else.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-display",
  display: "swap"
});

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
    <html lang="vi" data-scroll-behavior="smooth" className={`${inter.variable} ${archivo.variable}`}>
      <body className="min-h-screen bg-deep-space text-chalk-white antialiased">
        <GlobalNav />
        <ImageFallbackHandler />
        <main>{children}</main>
      </body>
    </html>
  );
}
