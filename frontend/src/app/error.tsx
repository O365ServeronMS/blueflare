"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect } from "react";

const RETRY_WINDOW_MS = 30_000;
const AUTO_RETRY_DELAY_MS = 1_500;

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const pathname = usePathname();

  const retry = useCallback(() => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }, [router, reset]);

  // One automatic retry per path every 30 s: most catalog errors are transient.
  useEffect(() => {
    const key = `bf-err-retry:${pathname}`;
    try {
      const last = Number(window.sessionStorage.getItem(key));
      if (last && Date.now() - last < RETRY_WINDOW_MS) return;
      window.sessionStorage.setItem(key, String(Date.now()));
    } catch {
      return;
    }
    const timer = window.setTimeout(retry, AUTO_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pathname, retry]);

  return (
    <section className="bf-content-width bf-page-gutter flex min-h-[70vh] items-center pt-20">
      <div>
        <p className="text-caption font-bold uppercase tracking-[0.14em] text-netflix-red">Mất kết nối thư viện</p>
        <h1 className="mt-3 text-[32px] font-black text-chalk-white sm:text-[44px]">Không tải được danh mục phim.</h1>
        <p className="mt-3 max-w-md text-body leading-6 text-silver">Máy chủ danh mục không phản hồi. Thử lại, hoặc mở phim bạn đã lưu.</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={retry} className="bf-play-cta">Thử lại</button>
          <a href="/favorites" className="bf-secondary-cta">Phim đã lưu</a>
        </div>
      </div>
    </section>
  );
}
