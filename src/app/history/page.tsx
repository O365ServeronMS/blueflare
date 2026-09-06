import type { Metadata } from "next";
import { StoredMovieGrid } from "@/components/StoredMovieGrid";

export const metadata: Metadata = { title: "Lịch sử — Blueflare" };

export default function HistoryPage() {
  return (
    <div className="bf-content-width pb-12 pt-24 md:pt-28">
      <header className="bf-page-gutter">
        <h1 className="text-[32px] font-black tracking-tight text-white sm:text-[44px]">Đã xem gần đây</h1>
        <p className="mt-3 max-w-lg text-body leading-6 text-silver">Lịch sử được lưu cục bộ khi bạn mở trình phát.</p>
      </header>
      <StoredMovieGrid type="history" />
    </div>
  );
}
