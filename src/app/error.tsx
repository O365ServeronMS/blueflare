"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="bf-content-width bf-page-gutter flex min-h-[70vh] items-center pt-20">
      <div>
        <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-netflix-red">Mất kết nối thư viện</p>
        <h1 className="mt-3 text-[36px] font-black text-chalk-white">Rạp phim đang tạm nghỉ.</h1>
        <p className="mt-3 max-w-md text-[15px] leading-6 text-silver">Blueflare chưa thể tải danh mục lúc này. Bạn có thể thử lại sau.</p>
        <button type="button" onClick={() => reset()} className="mt-6 min-h-11 rounded bg-chalk-white px-5 text-[14px] font-bold text-deep-space">Thử lại</button>
      </div>
    </section>
  );
}
