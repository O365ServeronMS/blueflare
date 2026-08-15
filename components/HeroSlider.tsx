"use client";

import { KeyboardEvent, TouchEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Info, Play } from "lucide-react";
import type { MovieCard } from "@/lib/types";
import { hrefWithReturnTo } from "@/lib/navigation";
import { getDisplayRating } from "@/lib/utils";

const SLIDE_INTERVAL_MS = 7000;

export function HeroSlider({ items }: { items: MovieCard[] }) {
  const slides = useMemo(
    () => [...items]
      .filter((movie) => movie.slug && (movie.poster || movie.thumb))
      .slice(0, 6),
    [items]
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [interactionTick, setInteractionTick] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (slides.length <= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setActiveIndex((current) => (current + 1) % slides.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [slides.length, interactionTick]);

  if (!slides.length) return null;
  const visibleIndex = activeIndex < slides.length ? activeIndex : 0;
  const active = slides[visibleIndex];
  const heroImage = active.poster || active.thumb;
  const displayRating = getDisplayRating(active);
  const detailHref = hrefWithReturnTo(`/movie/${active.slug}`, "/", "home");
  const playHref = hrefWithReturnTo(`/movie/${active.slug}?play=1#player`, "/", "home");
  const supportingCopy = [active.category, active.country].filter(Boolean).join(" · ");

  function move(direction: -1 | 1) {
    if (slides.length <= 1) return;
    setActiveIndex((current) => (current + direction + slides.length) % slides.length);
    setInteractionTick((current) => current + 1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    move(event.key === "ArrowLeft" ? -1 : 1);
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) move(deltaX < 0 ? 1 : -1);
  }

  return (
    <section
      className="relative h-[72vh] min-h-[520px] max-h-[880px] overflow-hidden bg-deep-space outline-none md:h-[78vh]"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      aria-roledescription="carousel"
      aria-label="Nội dung nổi bật"
    >
      <img
        key={active.slug}
        src={heroImage}
        alt=""
        width={1280}
        height={720}
        loading="eager"
        fetchPriority="high"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-center bf-reveal"
        data-movie-poster
        data-fallback-src={active.thumb || undefined}
        data-original-src={heroImage || undefined}
        data-placeholder-src="/image-placeholder.svg"
      />
      <div className="bf-hero-overlay absolute inset-0" />

      <div className="bf-content-width bf-page-gutter relative z-10 flex h-full items-end pb-28 md:items-center md:pb-14 md:pt-16">
        <div className="max-w-[34rem]">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-silver">Blueflare nổi bật</p>
          <h1 className="max-w-[12ch] text-[34px] font-black leading-[0.98] tracking-[-0.035em] text-chalk-white sm:text-[46px] md:text-[56px] lg:text-[64px]">
            {active.name}
          </h1>
          {active.originName && active.originName !== active.name ? (
            <p className="mt-3 line-clamp-1 max-w-lg text-[14px] font-medium text-silver md:text-[16px]">{active.originName}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-medium text-chalk-white">
            {displayRating ? <span>{displayRating.text}</span> : null}
            {active.year ? <span>{active.year}</span> : null}
            {active.quality ? <span>{active.quality}</span> : null}
            {active.episodeCurrent ? <span className="text-silver">{active.episodeCurrent}</span> : null}
          </div>
          {supportingCopy ? <p className="mt-3 line-clamp-2 max-w-xl text-[13px] leading-5 text-silver md:text-[15px] md:leading-6">{supportingCopy}</p> : null}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a href={playHref} className="inline-flex min-h-11 items-center justify-center gap-2 rounded bg-chalk-white px-5 py-2.5 text-[14px] font-bold text-deep-space transition hover:bg-silver">
              <Play className="h-5 w-5 fill-current" aria-hidden="true" />
              Phát
            </a>
            <a href={detailHref} className="inline-flex min-h-11 items-center justify-center gap-2 rounded bg-charcoal/80 px-5 py-2.5 text-[14px] font-bold text-chalk-white transition hover:bg-charcoal">
              <Info className="h-5 w-5" aria-hidden="true" />
              Thông tin khác
            </a>
          </div>
        </div>
      </div>

      {slides.length > 1 ? (
        <>
          <div className="absolute bottom-24 right-[var(--bf-page-gutter)] z-20 hidden items-center gap-1.5 md:flex" aria-label="Chọn nội dung nổi bật">
            {slides.map((movie, index) => (
              <button
                key={movie.slug}
                type="button"
                aria-label={`Hiển thị ${movie.name}`}
                aria-current={index === visibleIndex ? "true" : undefined}
                onClick={() => { setActiveIndex(index); setInteractionTick((tick) => tick + 1); }}
                className={index === visibleIndex ? "h-1 w-7 bg-netflix-red" : "h-1 w-4 bg-white/35 hover:bg-white/70"}
              />
            ))}
          </div>
          <button type="button" aria-label="Nội dung trước" onClick={() => move(-1)} className="absolute left-2 top-1/2 z-20 hidden h-16 w-10 -translate-y-1/2 place-items-center bg-black/35 text-chalk-white transition hover:bg-black/70 md:grid">
            <ChevronLeft className="h-7 w-7" />
          </button>
          <button type="button" aria-label="Nội dung tiếp theo" onClick={() => move(1)} className="absolute right-2 top-1/2 z-20 hidden h-16 w-10 -translate-y-1/2 place-items-center bg-black/35 text-chalk-white transition hover:bg-black/70 md:grid">
            <ChevronRight className="h-7 w-7" />
          </button>
        </>
      ) : null}
    </section>
  );
}
