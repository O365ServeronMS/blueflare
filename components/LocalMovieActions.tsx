"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Check, Clock3, Heart } from "lucide-react";
import type { MovieCard } from "@/lib/types";

const FAV_KEY = "film.bluesia.net:favorites";
const HISTORY_KEY = "film.bluesia.net:history";
const LEGACY_FAV_KEY = "bluesia:favorites";
const LEGACY_HISTORY_KEY = "bluesia:history";
const LOCAL_MOVIES_UPDATED_EVENT = "film.bluesia.net:local-movies-updated";
const LEGACY_LOCAL_MOVIES_UPDATED_EVENT = "bluesia:local-movies-updated";

type StoredMovie = MovieCard & { savedAt: number };

function readRaw(key: string): StoredMovie[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function read(key: string, legacyKey?: string): StoredMovie[] {
  const current = readRaw(key);
  if (current.length || !legacyKey) return current;
  return readRaw(legacyKey);
}

function write(key: string, movies: StoredMovie[]) {
  localStorage.setItem(key, JSON.stringify(movies.slice(0, 100)));
  window.dispatchEvent(new Event(LOCAL_MOVIES_UPDATED_EVENT));
  window.dispatchEvent(new Event(LEGACY_LOCAL_MOVIES_UPDATED_EVENT));
}

function subscribeToLocalMovies(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("focus", onStoreChange);
  window.addEventListener(LOCAL_MOVIES_UPDATED_EVENT, onStoreChange);
  window.addEventListener(LEGACY_LOCAL_MOVIES_UPDATED_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("focus", onStoreChange);
    window.removeEventListener(LOCAL_MOVIES_UPDATED_EVENT, onStoreChange);
    window.removeEventListener(LEGACY_LOCAL_MOVIES_UPDATED_EVENT, onStoreChange);
  };
}

function useStoredMovies(storageKey: string, legacyStorageKey: string) {
  const snapshot = useSyncExternalStore(
    subscribeToLocalMovies,
    () => JSON.stringify(read(storageKey, legacyStorageKey)),
    () => "[]"
  );

  return useMemo(() => JSON.parse(snapshot) as StoredMovie[], [snapshot]);
}

export function addHistory(movie: MovieCard) {
  if (typeof window === "undefined") return;
  const current = read(HISTORY_KEY, LEGACY_HISTORY_KEY).filter((item) => item.slug !== movie.slug);
  write(HISTORY_KEY, [{ ...movie, savedAt: Date.now() }, ...current]);
}

export function useLocalMovies(key: "favorites" | "history") {
  const storageKey = key === "favorites" ? FAV_KEY : HISTORY_KEY;
  const legacyStorageKey = key === "favorites" ? LEGACY_FAV_KEY : LEGACY_HISTORY_KEY;
  const items = useStoredMovies(storageKey, legacyStorageKey);
  return { items, setItems: (next: StoredMovie[]) => write(storageKey, next) };
}

export function useFavoriteToggle(movie: MovieCard) {
  const favorites = useStoredMovies(FAV_KEY, LEGACY_FAV_KEY);
  const isFavorite = useMemo(() => favorites.some((item) => item.slug === movie.slug), [favorites, movie.slug]);

  const toggle = () => {
    const current = read(FAV_KEY, LEGACY_FAV_KEY);
    const next = current.some((item) => item.slug === movie.slug)
      ? current.filter((item) => item.slug !== movie.slug)
      : [{ ...movie, savedAt: Date.now() }, ...current];
    write(FAV_KEY, next);
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
