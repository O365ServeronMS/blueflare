"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="bf-content-width bf-page-gutter flex min-h-[70vh] items-center pt-20">
      <div>
        <p className="text-caption font-bold uppercase tracking-[0.14em] text-netflix-red">Mất kết nối thư viện</p>
        <h1 className="mt-3 text-[32px] font-black text-chalk-white sm:text-[44px]">Không tải được danh mục phim.</h1>
        <p className="mt-3 max-w-md text-body leading-6 text-silver">Máy chủ danh mục không phản hồi. Thử lại, hoặc mở phim bạn đã lưu.</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => reset()} className="bf-play-cta">Thử lại</button>
          <a href="/favorites" className="bf-secondary-cta">Phim đã lưu</a>
        </div>
      </div>
    </section>
  );
}
