import type { Metadata } from "next";
import { Be_Vietnam_Pro } from "next/font/google";
import { GlobalNav } from "@/components/GlobalNav";
import { ImageFallbackHandler } from "@/src/app/image-fallback-handler";
import { readFrontendFeatures } from "@/lib/features";
import "@/src/styles/globals.css";

// Be Vietnam Pro: dấu thanh tiếng Việt được vẽ chủ đích thay vì chắp thêm, quan
// trọng với giao diện toàn tiếng Việt có nhiều tiêu đề nén chặt. Không phải
// variable font nên weight phải liệt kê tường minh — 900 là bắt buộc, thiếu nó
// thì numeral Top-10 và H1 hero bị trình duyệt tổng hợp faux-bold.
const bodyFont = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "700", "900"],
  variable: "--font-bf",
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
  title: "Blueflare",
  description: "Góc nhỏ của người đam mê phim",
  applicationName: "Blueflare",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png"
  },
  manifest: "/manifest.webmanifest"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const features = readFrontendFeatures();
  return (
    <html lang="vi" data-scroll-behavior="smooth" className={bodyFont.variable}>
      <body className="min-h-screen bg-deep-space text-chalk-white antialiased">
        <GlobalNav featureSearch={features.searchSuggest} featureLocalLibrary={features.localLibrary} />
        <ImageFallbackHandler />
        <main>{children}</main>
      </body>
    </html>
  );
}
