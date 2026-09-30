"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Check, Clock3, Heart } from "lucide-react";
import type { MovieCard } from "@/lib/types";
import {
  SERVER_SNAPSHOT,
  getSnapshot,
  parseSnapshot,
  recordHistory,
  replaceList,
  subscribeMovieStore,
  toggleFavorite,
  type ListKey,
} from "@/lib/movie-store";

type StoredMovie = MovieCard & { savedAt: number };

function useStoredMovies(list: ListKey) {
  const snapshot = useSyncExternalStore(
    subscribeMovieStore,
    () => getSnapshot(list),
    () => SERVER_SNAPSHOT
  );

  return useMemo(() => parseSnapshot(snapshot), [snapshot]);
}

export function addHistory(movie: MovieCard) {
  void recordHistory(movie);
}

export function useLocalMovies(key: ListKey) {
  const { items, mode } = useStoredMovies(key);
  return { items, loading: mode === "loading", setItems: (next: StoredMovie[]) => void replaceList(key, next) };
}

export function useFavoriteToggle(movie: MovieCard) {
  const { items: favorites } = useStoredMovies("favorites");
  const isFavorite = useMemo(() => favorites.some((item) => item.slug === movie.slug), [favorites, movie.slug]);

  const toggle = () => {
    void toggleFavorite(movie);
  };

  return { isFavorite, toggle };
}

export function MovieActions({ movie }: { movie: MovieCard }) {
  const { isFavorite, toggle: toggleFavorite } = useFavoriteToggle(movie);

  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={toggleFavorite}
        className="bf-secondary-cta bf-cta-compact"
        aria-pressed={isFavorite}
        aria-label={isFavorite ? "Bỏ khỏi danh sách của tôi" : "Thêm vào danh sách của tôi"}
      >
        {isFavorite ? <Check className="h-5 w-5" aria-hidden="true" /> : <Heart className="h-5 w-5" aria-hidden="true" />}
        <span className="bf-cta-label">{isFavorite ? "Đã lưu" : "Danh sách của tôi"}</span>
      </button>
      <button
        onClick={() => addHistory(movie)}
        className="bf-secondary-cta bf-cta-compact"
        aria-label="Lưu lịch sử"
      >
        <Clock3 className="h-5 w-5" aria-hidden="true" />
        <span className="bf-cta-label">Lưu lịch sử</span>
      </button>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <section className="bf-page-gutter flex min-h-[55vh] items-center py-20">
      <div className="max-w-lg">
        <h2 className="text-[32px] font-black tracking-tight text-white sm:text-[44px]">{title}</h2>
        <p className="mt-4 text-body leading-6 text-silver">{description}</p>
        <a href="/" className="mt-6 inline-flex min-h-11 items-center rounded bg-white px-5 py-2.5 text-control font-bold text-black">Khám phá phim</a>
      </div>
    </section>
  );
}
