import type { Metadata } from "next";

export const metadata: Metadata = { title: "Thông tin — Blueflare" };

export default function SettingsPage() {
  return (
    <div className="bf-content-width bf-page-gutter pb-16 pt-24 md:pt-28">
      <header className="max-w-2xl">
        <h1 className="text-[32px] font-black tracking-tight text-white sm:text-[44px]">Điện ảnh là trung tâm.</h1>
        <p className="mt-4 text-body leading-7 text-silver">Blueflare là nơi tìm và xem phim, không cần tài khoản.</p>
      </header>
      <div className="mt-12 grid max-w-5xl gap-10 border-t border-white/10 pt-9 md:grid-cols-3">
        <section><h2 className="text-body font-bold text-white">Truy cập</h2><p className="mt-3 text-control leading-6 text-silver">Ứng dụng mở, không yêu cầu đăng nhập. Domain sản xuất là <code>phim.bluesia.net</code>.</p></section>
        <section><h2 className="text-body font-bold text-white">Nguồn dữ liệu</h2><p className="mt-3 text-control leading-6 text-silver">Thông tin phim và ảnh do Blueflare tự lưu và phục vụ.</p><p className="mt-2 text-control leading-6 text-ash">Video phát trực tiếp từ nguồn bên thứ ba. Blueflare không lưu và không trung chuyển tệp video.</p></section>
        <section><h2 className="text-body font-bold text-white">Minh bạch</h2><p className="mt-3 text-control leading-6 text-silver">Blueflare không lưu trữ, phân phối hoặc sở hữu các tệp video. Nội dung phát đến từ nguồn bên thứ ba.</p></section>
      </div>
      <p className="mt-12 max-w-xl border-t border-white/10 pt-6 text-micro leading-5 text-ash">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
  );
}
