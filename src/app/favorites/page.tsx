import type { Metadata } from "next";
import { StoredMovieGrid } from "@/components/StoredMovieGrid";

export const metadata: Metadata = { title: "Yêu thích — Bluesia Cinema" };

export default function FavoritesPage() {
  return (
    <div className="bf-content-width pb-12 pt-32 lg:pt-28">
      <header className="bf-page-gutter">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Thư viện cá nhân</p>
        <h1 className="mt-2 text-[34px] font-black tracking-tight text-white sm:text-[48px]">Danh sách của tôi</h1>
        <p className="mt-3 max-w-lg text-[14px] leading-6 text-silver">Những bộ phim bạn đã lưu trên trình duyệt này.</p>
      </header>
      <StoredMovieGrid type="favorites" />
    </div>
  );
}
