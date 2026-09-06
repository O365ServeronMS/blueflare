"use client";

import { useLocalMovies, EmptyState } from "@/components/LocalMovieActions";
import { MovieCard } from "@/components/MovieCard";

export function StoredMovieGrid({ type }: { type: "favorites" | "history" }) {
  const { items } = useLocalMovies(type);

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
      {items.map((movie) => <MovieCard key={movie.slug} movie={movie} />)}
    </div>
  );
}
