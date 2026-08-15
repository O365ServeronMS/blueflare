"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { searchMovies } from "@/lib/catalog";
import { createReturnToPath, hrefWithReturnTo } from "@/lib/navigation";
import type { MovieCard } from "@/lib/types";

type SearchSuggestProps = {
  initialQuery?: string;
  autoFocus?: boolean;
  syncWithUrl?: boolean;
};

type SearchState = "idle" | "loading" | "ready" | "empty" | "error";

const MIN_QUERY_LENGTH = 2;
const SUGGESTION_LIMIT = 6;

export function SearchSuggest({ initialQuery = "", autoFocus = false, syncWithUrl = false }: SearchSuggestProps) {
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<MovieCard[]>([]);
  const [state, setState] = useState<SearchState>("idle");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!syncWithUrl) return;
    function syncQuery() {
      const nextQuery = new URLSearchParams(window.location.search).get("q") || "";
      setQuery(nextQuery);
      setOpen(false);
      setItems([]);
      setState("idle");
      if (autoFocus && !nextQuery) inputRef.current?.focus();
    }
    syncQuery();
    window.addEventListener("popstate", syncQuery);
    return () => window.removeEventListener("popstate", syncQuery);
  }, [autoFocus, syncWithUrl]);

  useEffect(() => {
    const value = query.trim();
    if (value.length < MIN_QUERY_LENGTH) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      setState("loading");
      try {
        const data = await searchMovies(value, 1);
        if (!active) return;
        const nextItems = data.items.slice(0, SUGGESTION_LIMIT);
        setItems(nextItems);
        setState(nextItems.length ? "ready" : "empty");
      } catch {
        if (!active) return;
        setItems([]);
        setState("error");
      }
    }, 280);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function updateQuery(nextQuery: string) {
    setQuery(nextQuery);
    setOpen(true);
    if (nextQuery.trim().length < MIN_QUERY_LENGTH) {
      setItems([]);
      setState("idle");
    }
  }

  const showPanel = open && query.trim().length >= MIN_QUERY_LENGTH;
  const returnTo = typeof window === "undefined"
    ? "/search"
    : createReturnToPath(window.location.pathname, window.location.search) || "/search";

  return (
    <form ref={rootRef} action="/search" method="get" onSubmit={() => setOpen(false)} className="relative min-w-0 flex-1">
      <label className="flex min-h-11 min-w-0 items-center gap-3 border border-white/35 bg-black px-3 text-silver transition focus-within:border-white">
        <span className="sr-only">Tìm kiếm phim</span>
        <Search className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          name="q"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Tên phim, diễn viên hoặc thể loại"
          className="bf-search-input min-w-0 flex-1 bg-transparent py-2 text-[14px] text-white outline-none placeholder:text-ash"
          autoFocus={autoFocus && !syncWithUrl}
          autoComplete="off"
        />
      </label>

      {showPanel ? (
        <div className="absolute inset-x-0 top-[calc(100%+8px)] z-[70] max-h-[72vh] overflow-y-auto border border-white/15 bg-black">
          {state === "loading" ? <p className="px-4 py-4 text-[13px] text-silver" role="status">Đang tìm...</p> : null}
          {state === "ready" ? items.map((movie) => (
            <a key={movie.slug} href={hrefWithReturnTo(`/movie/${movie.slug}`, returnTo)} onClick={() => setOpen(false)} className="flex items-center gap-3 border-b border-white/10 px-3 py-2.5 transition last:border-0 hover:bg-graphite focus:bg-graphite">
              <span className="h-[72px] w-12 shrink-0 overflow-hidden rounded-sm bg-graphite">
                {movie.thumb || movie.poster ? (
                  <img
                    src={movie.thumb || movie.poster}
                    alt=""
                    width={96}
                    height={144}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                    data-movie-poster
                    data-fallback-src={movie.poster || undefined}
                    data-original-src={movie.thumb || undefined}
                    data-placeholder-src="/image-placeholder.svg"
                  />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 text-[14px] font-bold text-white">{movie.name}</span>
                {movie.originName ? <span className="mt-0.5 block truncate text-[12px] text-silver">{movie.originName}</span> : null}
                <span className="mt-1 flex gap-2 text-[11px] text-ash">
                  {movie.year ? <span>{movie.year}</span> : null}
                  {movie.quality ? <span>{movie.quality}</span> : null}
                  {movie.episodeCurrent ? <span>{movie.episodeCurrent}</span> : null}
                </span>
              </span>
            </a>
          )) : null}
          {state === "empty" ? <p className="px-4 py-4 text-[13px] text-silver">Không có gợi ý phù hợp.</p> : null}
          {state === "error" ? <p className="px-4 py-4 text-[13px] text-silver">Chưa tải được gợi ý.</p> : null}
          <a href={`/search?q=${encodeURIComponent(query.trim())}`} className="block border-t border-white/15 px-4 py-3 text-center text-[12px] font-bold text-white hover:bg-graphite">Xem tất cả kết quả</a>
        </div>
      ) : null}
    </form>
  );
}
