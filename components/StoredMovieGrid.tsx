"use client";

import { X } from "lucide-react";
import { useLocalMovies, EmptyState } from "@/components/LocalMovieActions";
import { MovieCard } from "@/components/MovieCard";
import { hrefWithReturnTo } from "@/lib/navigation";
import { toEpisodeRef } from "@/lib/movie-sync";
import { clearHistory } from "@/lib/movie-store";

export function StoredMovieGrid({ type }: { type: "favorites" | "history" }) {
  const { items, loading, setItems } = useLocalMovies(type);

  if (loading && !items.length) return null;

  if (!items.length) {
    return (
      <EmptyState
        title={type === "favorites" ? "Chưa có phim yêu thích" : "Chưa có lịch sử xem"}
        description={type === "favorites"
          ? "Bấm biểu tượng trái tim ở bất kỳ phim nào để lưu vào đây."
          : "Phim bạn mở trình phát sẽ được ghi lại ở đây."}
      />
    );
  }

  const isHistory = type === "history";
  const onClear = () => {
    if (window.confirm("Xoá toàn bộ lịch sử xem? Không thể hoàn tác.")) void clearHistory();
  };

  return (
    <>
      {isHistory && (
        <div className="bf-page-gutter flex justify-end pt-6">
          <button type="button" onClick={onClear} className="min-h-11 rounded border border-white/20 px-4 py-2 text-control font-bold text-white hover:bg-white/10">
            Xoá toàn bộ lịch sử
          </button>
        </div>
      )}
      <div className="bf-page-gutter grid grid-cols-2 gap-x-3 gap-y-7 pt-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
        {items.map((movie) => {
          // Only history rows of series carry an episode. The server index is not known
          // here (cards have no episode list), so link with ep + sn and let the movie page resolve it.
          const ep = isHistory && movie.type !== "single" ? toEpisodeRef(movie.ep) : undefined;
          let card = <MovieCard movie={movie} />;
          if (ep) {
            const sn = ep.server ? `&sn=${encodeURIComponent(ep.server)}` : "";
            const href = hrefWithReturnTo(`/movie/${movie.slug}?ep=${encodeURIComponent(ep.key)}${sn}&play=1#player`, "");
            card = <MovieCard movie={movie} badge={ep.name} href={href} />;
          }
          if (!isHistory) return <MovieCard key={movie.slug} movie={movie} />;
          return (
            <div key={movie.slug} className="relative">
              {card}
              <button
                type="button"
                aria-label={`Xoá ${movie.name} khỏi lịch sử`}
                onClick={() => setItems(items.filter((item) => item.slug !== movie.slug))}
                className="absolute right-1.5 top-1.5 z-10 grid size-8 place-items-center rounded-full bg-black/70 text-white hover:bg-black"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
