"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { MovieCard } from "@/components/MovieCard";
import { SectionRow } from "@/components/SectionRow";
import { useAccount } from "@/components/useAccount";
import { continueCardHref, fetchContinueWatching, parseContinueEntries, type ContinueEntry } from "@/lib/continue-watching";

/**
 * Home "Phim đang xem" rail. Pure client hydration: renders nothing for
 * guests, while loading, or when the list is empty, so the cached server
 * HTML is identical for everyone.
 */
export function ContinueWatchingRow({ slideDurationMs }: { slideDurationMs?: number }) {
  const account = useAccount("/");
  const [entries, setEntries] = useState<ContinueEntry[]>([]);

  useEffect(() => {
    if (account !== "user") {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void fetchContinueWatching().then((body) => {
      if (!cancelled) setEntries(parseContinueEntries(body));
    });
    return () => {
      cancelled = true;
    };
  }, [account]);

  async function remove(entry: ContinueEntry) {
    const slug = entry.movie.slug;
    let index = 0;
    setEntries((prev) => {
      index = prev.findIndex((e) => e.movie.slug === slug);
      return prev.filter((e) => e.movie.slug !== slug);
    });
    const restore = () =>
      setEntries((prev) => {
        if (prev.some((e) => e.movie.slug === slug)) return prev;
        const next = [...prev];
        next.splice(Math.min(Math.max(index, 0), next.length), 0, entry);
        return next;
      });
    try {
      const res = await fetch(`/api/me/progress/${encodeURIComponent(slug)}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) restore();
    } catch {
      restore();
    }
  }

  if (account !== "user" || !entries.length) return null;
  const bySlug = new Map(entries.map((e) => [e.movie.slug, e]));

  return (
    <SectionRow
      title="Phim đang xem"
      items={entries.map((e) => e.movie)}
      itemLimit={20}
      returnTo="/"
      slideDurationMs={slideDurationMs}
      renderCard={(movie) => {
        const entry = bySlug.get(movie.slug);
        if (!entry) return null;
        return (
          <div className="group relative">
            <MovieCard movie={movie} compact returnTo="/" progress={entry.item.progress} href={continueCardHref(entry.item, "/")} />
            <button
              type="button"
              aria-label="Xóa khỏi Phim đang xem"
              onClick={() => void remove(entry)}
              className="absolute right-1 top-1 z-20 grid h-7 w-7 place-items-center rounded-full bg-black/75 text-chalk-white transition hover:bg-netflix-red focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      }}
    />
  );
}
