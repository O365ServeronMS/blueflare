import type { Metadata } from "next";
import { StoredMovieGrid } from "@/components/StoredMovieGrid";

export const metadata: Metadata = { title: "Yêu thích — Blueflare" };

export default function FavoritesPage() {
  return (
    <div className="bf-content-width pb-12 pt-24 md:pt-28">
      <header className="bf-page-gutter">
        <h1 className="text-[32px] font-black tracking-tight text-white sm:text-[44px]">Danh sách của tôi</h1>
        <p className="mt-3 max-w-lg text-body leading-6 text-silver">Những bộ phim bạn đã lưu trên trình duyệt này.</p>
      </header>
      <StoredMovieGrid type="favorites" />
    </div>
  );
}
