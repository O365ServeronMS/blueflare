import Link from "next/link";

export default function NotFound() {
  return (
    <section className="bf-content-width bf-page-gutter flex min-h-[70vh] items-center pt-20">
      <div>
        <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-netflix-red">404</p>
        <h1 className="mt-3 text-[36px] font-black text-chalk-white">Không tìm thấy trang.</h1>
        <p className="mt-3 max-w-md text-[15px] leading-6 text-silver">Đường dẫn này không còn tồn tại hoặc nội dung đã được chuyển.</p>
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded bg-chalk-white px-5 text-[14px] font-bold text-deep-space">Về trang chủ</Link>
      </div>
    </section>
  );
}
