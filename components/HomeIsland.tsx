import { useEffect, useState } from "react";
import { HeroSlider } from "./HeroSlider";
import { SectionRow } from "./SectionRow";
import { getHome } from "@/lib/catalog";
import type { HomePayload } from "@/lib/types";

export function HomeIsland({
  initialData,
  returnTo
}: {
  initialData?: HomePayload;
  returnTo: string;
}) {
  const [data, setData] = useState<HomePayload | null>(initialData || null);
  const [visibleSections, setVisibleSections] = useState(2);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    getHome()
      .then((home) => active && setData(home))
      .catch((err) => {
        console.error("[HomeIsland] Failed to load home-data", err);
        if (active && !initialData) setError(true);
      });
    return () => { active = false; };
  }, [initialData]);

  useEffect(() => {
    if (!data || visibleSections >= data.sections.length) return;
    const timer = window.setTimeout(() => setVisibleSections((previous) => previous + 1), 120);
    return () => window.clearTimeout(timer);
  }, [data, visibleSections]);

  if (error) {
    return (
      <section className="flex min-h-[560px] items-end bg-deep-space bf-page-gutter pb-20 pt-24">
        <div className="max-w-xl">
          <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-netflix-red">Mất kết nối thư viện</p>
          <h1 className="mt-3 text-[36px] font-black leading-tight tracking-tight text-chalk-white sm:text-[52px]">Rạp phim đang tạm nghỉ.</h1>
          <p className="mt-4 max-w-md text-[15px] leading-6 text-silver">Blueflare chưa thể tải danh mục lúc này. Bạn vẫn có thể mở thư viện cá nhân hoặc thử lại sau.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded bg-chalk-white px-5 py-2.5 text-[14px] font-bold text-deep-space">Thử lại</button>
            <a href="/favorites" className="inline-flex min-h-11 items-center rounded bg-graphite px-5 py-2.5 text-[14px] font-bold text-chalk-white">Phim đã lưu</a>
          </div>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <div aria-busy="true" aria-label="Đang tải trang chủ">
        <div className="h-[72vh] min-h-[520px] animate-pulse bg-graphite" />
        <div className="relative z-10 -mt-16 space-y-10">
          {[0, 1].map((row) => (
            <section key={row}>
              <div className="bf-page-gutter mb-3 h-5 w-44"><div className="h-full animate-pulse rounded-sm bg-graphite" /></div>
              <div className="flex gap-2 overflow-hidden px-[var(--bf-page-gutter)]">
                {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="aspect-[2/3] w-[32vw] min-w-[124px] max-w-[190px] animate-pulse rounded bg-graphite sm:w-[22vw] lg:w-[13vw]" />)}
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <HeroSlider items={data.hero} />
      <div className="pb-6">
        {data.sections.slice(0, visibleSections).map((section, index) => (
          <SectionRow
            key={section.href || index}
            title={section.title}
            href={section.href}
            items={section.items}
            returnTo={returnTo}
            spotlight={index === 0}
            itemLimit={section.href === "/list/phim-moi-cap-nhat" ? 24 : 16}
          />
        ))}
      </div>
    </>
  );
}
