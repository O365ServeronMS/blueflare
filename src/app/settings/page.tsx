import type { Metadata } from "next";

export const metadata: Metadata = { title: "Thông tin — Bluesia Cinema" };

export default function SettingsPage() {
  return (
    <div className="bf-content-width bf-page-gutter pb-16 pt-32 lg:pt-28">
      <header className="max-w-3xl">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Về Blueflare</p>
        <h1 className="mt-2 text-[34px] font-black tracking-tight text-white sm:text-[48px]">Điện ảnh là trung tâm.</h1>
        <p className="mt-4 text-[15px] leading-7 text-silver">Blueflare là giao diện khám phá phim render trên VPS, tối ưu cho tốc độ và trải nghiệm xem liền mạch.</p>
      </header>
      <div className="mt-12 grid max-w-5xl gap-10 border-t border-white/10 pt-9 md:grid-cols-3">
        <section><h2 className="text-[16px] font-bold text-white">Truy cập</h2><p className="mt-3 text-[13px] leading-6 text-silver">Ứng dụng mở, không yêu cầu đăng nhập. Domain sản xuất là <code>phim.bluesia.net</code>.</p></section>
        <section><h2 className="text-[16px] font-bold text-white">Nguồn dữ liệu</h2><p className="mt-3 break-all text-[13px] leading-6 text-silver">https://img.bluesia.net/api/*</p><p className="mt-2 text-[13px] leading-6 text-ash">Catalog, metadata, tập phim và ảnh ký sẵn được phục vụ bởi catalog-api. Frontend không proxy video.</p></section>
        <section><h2 className="text-[16px] font-bold text-white">Minh bạch</h2><p className="mt-3 text-[13px] leading-6 text-silver">Blueflare không lưu trữ, phân phối hoặc sở hữu các tệp video. Nội dung phát đến từ nguồn bên thứ ba.</p></section>
      </div>
      <p className="mt-12 max-w-xl border-t border-white/10 pt-6 text-[11px] leading-5 text-ash">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
  );
}
