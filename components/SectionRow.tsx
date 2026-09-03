"use client";

import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MovieCard as MovieCardType } from "@/lib/types";
import { getRailSlideTarget, type RailDirection } from "@/lib/rail-motion";
import { MovieCard } from "@/components/MovieCard";

const RAIL_SLIDE_DURATION_MS = 300;

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

export function SectionRow({
  title,
  href,
  items,
  returnTo = "",
  spotlight = false,
  itemLimit = 16,
  ranked = false
}: {
  title: string;
  href: string;
  items: MovieCardType[];
  returnTo?: string;
  spotlight?: boolean;
  itemLimit?: number;
  ranked?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const animationTargetRef = useRef<number | null>(null);
  const animatedTrackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    if (animatedTrackRef.current) animatedTrackRef.current.style.scrollSnapType = "";
  }, []);

  if (!items.length) return null;

  function cancelRailAnimation(restoreSnap = true) {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    if (restoreSnap && animatedTrackRef.current) animatedTrackRef.current.style.scrollSnapType = "";
    animationFrameRef.current = null;
    animationTargetRef.current = null;
    animatedTrackRef.current = null;
  }

  function scroll(direction: RailDirection) {
    const track = trackRef.current;
    if (!track) return;

    const queuedOrigin = animationTargetRef.current;
    cancelRailAnimation(false);

    const firstCard = track.firstElementChild as HTMLElement | null;
    const firstCardLeft = firstCard?.offsetLeft ?? 0;
    const snapPoints = Array.from(track.children, (child) => (
      (child as HTMLElement).offsetLeft - firstCardLeft
    ));
    const target = getRailSlideTarget({
      origin: queuedOrigin ?? track.scrollLeft,
      direction,
      viewportWidth: track.clientWidth,
      maxScrollLeft: track.scrollWidth - track.clientWidth,
      snapPoints
    });
    const start = track.scrollLeft;

    // Cố ý animate kể cả khi prefers-reduced-motion: trượt trong carousel do
    // người dùng chủ động bấm <> được coi là chấp nhận được, và nếu tôn trọng
    // cài đặt này thì nút chỉ nhảy tức thì ("chớp") — không phải điều muốn ở đây.
    if (Math.abs(target - start) <= 1) {
      track.scrollLeft = target;
      track.style.scrollSnapType = "";
      return;
    }

    track.style.scrollSnapType = "none";
    animatedTrackRef.current = track;
    animationTargetRef.current = target;
    const animatedTrack: HTMLDivElement = track;
    let startedAt: number | null = null;

    function animate(timestamp: number) {
      if (startedAt === null) startedAt = timestamp;
      const progress = Math.min((timestamp - startedAt) / RAIL_SLIDE_DURATION_MS, 1);
      animatedTrack.scrollLeft = start + (target - start) * easeOutCubic(progress);

      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(animate);
        return;
      }

      animatedTrack.scrollLeft = target;
      animatedTrack.style.scrollSnapType = "";
      animationFrameRef.current = null;
      animationTargetRef.current = null;
      animatedTrackRef.current = null;
    }

    animationFrameRef.current = window.requestAnimationFrame(animate);
  }

  return (
    <section className={spotlight ? "relative z-20 mt-6 pb-3 md:-mt-20" : "relative mt-7 pb-3 md:mt-10"} aria-labelledby={`rail-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <div className="bf-content-width bf-page-gutter mb-3 flex items-end justify-between gap-4">
        <a href={href} className="group inline-flex min-w-0 items-center gap-2">
          <h2 id={`rail-${title.replace(/\s+/g, "-").toLowerCase()}`} className="line-clamp-1 text-[17px] font-bold leading-tight text-chalk-white md:text-[20px]">
            {title}
          </h2>
          <span className="hidden text-[12px] font-medium text-silver transition group-hover:text-chalk-white sm:inline">Khám phá</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-silver transition-transform group-hover:translate-x-0.5 group-hover:text-chalk-white" />
        </a>
        <div className="hidden items-center gap-1 md:flex">
          <button type="button" aria-label={`Cuộn ${title} sang trái`} onClick={() => scroll(-1)} className="grid h-8 w-8 place-items-center rounded-sm bg-black/80 text-silver transition hover:bg-graphite hover:text-chalk-white">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button type="button" aria-label={`Cuộn ${title} sang phải`} onClick={() => scroll(1)} className="grid h-8 w-8 place-items-center rounded-sm bg-black/80 text-silver transition hover:bg-graphite hover:text-chalk-white">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div
        ref={trackRef}
        className="bf-rail-track flex snap-x snap-mandatory gap-1.5 overflow-x-auto px-[var(--bf-page-gutter)] pb-4 pt-1 sm:gap-2"
        tabIndex={0}
        onPointerDown={() => cancelRailAnimation()}
        onWheel={() => cancelRailAnimation()}
      >
        {items.slice(0, itemLimit).map((movie, index) => (
          <div key={movie.slug} className="w-[32vw] min-w-[124px] max-w-[190px] shrink-0 snap-start sm:w-[22vw] lg:w-[13vw]">
            <MovieCard movie={movie} compact returnTo={returnTo} rank={ranked ? index + 1 : undefined} />
          </div>
        ))}
      </div>
    </section>
  );
}
