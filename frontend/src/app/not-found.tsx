import Link from "next/link";

export default function NotFound() {
  return (
    <section className="bf-content-width bf-page-gutter flex min-h-[70vh] items-center pt-20">
      <div>
        <p className="text-caption font-bold uppercase tracking-[0.14em] text-netflix-red">404</p>
        <h1 className="mt-3 text-[32px] font-black text-chalk-white sm:text-[44px]">Không tìm thấy trang.</h1>
        <p className="mt-3 max-w-md text-body leading-6 text-silver">Đường dẫn này không còn tồn tại. Quay về trang chủ hoặc tìm phim theo tên.</p>
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded bg-chalk-white px-5 text-body font-bold text-deep-space">Về trang chủ</Link>
      </div>
    </section>
  );
}
