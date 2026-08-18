"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MovieCard as MovieCardType } from "@/lib/types";
import { MovieCard } from "@/components/MovieCard";

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
  if (!items.length) return null;

  function scroll(direction: -1 | 1) {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * track.clientWidth * 0.82, behavior: "smooth" });
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
      <div ref={trackRef} className="bf-rail-track flex snap-x snap-mandatory gap-1.5 overflow-x-auto px-[var(--bf-page-gutter)] pb-4 pt-1 sm:gap-2" tabIndex={0}>
        {items.slice(0, itemLimit).map((movie, index) => (
          <div key={movie.slug} className="relative w-[32vw] min-w-[124px] max-w-[190px] shrink-0 snap-start sm:w-[22vw] lg:w-[13vw]">
            {ranked ? <span className="bf-rank pointer-events-none absolute -bottom-2.5 -left-1 z-30">{index + 1}</span> : null}
            <MovieCard movie={movie} compact returnTo={returnTo} />
          </div>
        ))}
      </div>
    </section>
  );
}
