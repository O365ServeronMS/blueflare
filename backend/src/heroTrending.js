// Lấy candidate từ TMDB Trending, mở rộng thêm trang khi chưa đủ phim phát được
// trong catalog để đạt `limit`. Dừng ở maxPages rồi trả về những gì có.
export async function collectHeroTrending({ fetchIds, resolve, limit, pages, maxPages, step = 2 }) {
  let depth = Math.max(1, pages);
  const ceiling = Math.max(depth, maxPages);
  for (;;) {
    const candidateIds = await fetchIds({ pages: depth });
    const matches = await resolve(candidateIds, limit);
    if (matches.length >= limit || depth >= ceiling) return { candidateIds, matches, pages: depth };
    depth = Math.min(ceiling, depth + step);
  }
}
