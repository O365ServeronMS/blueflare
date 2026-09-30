"use client";

import { useLocalMovies, EmptyState } from "@/components/LocalMovieActions";
import { MovieCard } from "@/components/MovieCard";
import { hrefWithReturnTo } from "@/lib/navigation";
import { toEpisodeRef } from "@/lib/movie-sync";

export function StoredMovieGrid({ type }: { type: "favorites" | "history" }) {
  const { items, loading } = useLocalMovies(type);

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

  return (
    <div className="bf-page-gutter grid grid-cols-2 gap-x-3 gap-y-7 pt-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
      {items.map((movie) => {
        // Only history rows of series carry an episode. The server index is not known
        // here (cards have no episode list), so link with ep + sn and let the movie page resolve it.
        const ep = type === "history" && movie.type !== "single" ? toEpisodeRef(movie.ep) : undefined;
        if (!ep) return <MovieCard key={movie.slug} movie={movie} />;
        const sn = ep.server ? `&sn=${encodeURIComponent(ep.server)}` : "";
        const href = hrefWithReturnTo(`/movie/${movie.slug}?ep=${encodeURIComponent(ep.key)}${sn}&play=1#player`, "");
        return <MovieCard key={movie.slug} movie={movie} badge={ep.name} href={href} />;
      })}
    </div>
  );
}
