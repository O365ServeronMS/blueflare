import { describe, test, expect } from "vitest";
import { normalizeCard } from "./catalog";

describe("normalizeCard", () => {
  test("maps standard fields", () => {
    const result = normalizeCard({
      name: "Test Movie",
      origin_name: "Original Title",
      slug: "test-movie",
      thumb_url: "https://img.test/i/m/thumb.webp",
      poster_url: "https://img.test/i/d/poster.webp",
      year: 2026,
      quality: "FHD",
      lang: "Vietsub",
      type: "single",
      status: "completed",
    });
    expect(result.name).toBe("Test Movie");
    expect(result.originName).toBe("Original Title");
    expect(result.slug).toBe("test-movie");
    expect(result.thumb).toBe("https://img.test/i/m/thumb.webp");
    expect(result.poster).toBe("https://img.test/i/d/poster.webp");
    expect(result.year).toBe(2026);
    expect(result.quality).toBe("FHD");
    expect(result.lang).toBe("Vietsub");
    expect(result.type).toBe("single");
    expect(result.status).toBe("completed");
  });

  test("falls back name to origin_name", () => {
    const result = normalizeCard({ origin_name: "Fallback" });
    expect(result.name).toBe("Fallback");
  });

  test("falls back to 'Không rõ tên' when no name", () => {
    const result = normalizeCard({});
    expect(result.name).toBe("Không rõ tên");
  });

  test("falls back thumb to poster_url and vice versa", () => {
    const onlyPoster = normalizeCard({ poster_url: "poster.webp" });
    expect(onlyPoster.thumb).toBe("poster.webp");
    expect(onlyPoster.poster).toBe("poster.webp");

    const onlyThumb = normalizeCard({ thumb_url: "thumb.webp" });
    expect(onlyThumb.thumb).toBe("thumb.webp");
    expect(onlyThumb.poster).toBe("thumb.webp");
  });

  test("extracts TMDB rating from nested tmdb object", () => {
    const result = normalizeCard({ tmdb: { vote_average: 8.5, vote_count: 100 } });
    expect(result.tmdbRating).toBe(8.5);
    expect(result.tmdb?.vote_average).toBe(8.5);
    expect(result.tmdb?.vote_count).toBe(100);
  });

  test("extracts TMDB rating from flat vote_average", () => {
    const result = normalizeCard({ vote_average: 7.2 });
    expect(result.tmdbRating).toBe(7.2);
  });

  test("extracts IMDb rating from nested imdb object", () => {
    const result = normalizeCard({ imdb: { vote_average: 8.0, vote_count: 500 } });
    expect(result.imdbRating).toBe(8.0);
    expect(result.imdb?.rating).toBe(8.0);
  });

  test("extracts IMDb rating from imdb.rating field", () => {
    const result = normalizeCard({ imdb: { rating: 7.5 } });
    expect(result.imdbRating).toBe(7.5);
  });

  test("ignores zero/negative/non-finite ratings", () => {
    expect(normalizeCard({ vote_average: 0 }).tmdbRating).toBeUndefined();
    expect(normalizeCard({ vote_average: -1 }).tmdbRating).toBeUndefined();
    expect(normalizeCard({ vote_average: NaN }).tmdbRating).toBeUndefined();
    expect(normalizeCard({ vote_average: Infinity }).tmdbRating).toBeUndefined();
  });

  test("returns empty slug for null/undefined", () => {
    expect(normalizeCard({}).slug).toBe("");
    expect(normalizeCard({ slug: null }).slug).toBe("");
  });

  test("uses _id as slug fallback", () => {
    expect(normalizeCard({ _id: "abc123" }).slug).toBe("abc123");
  });

  test("extracts category as label text from array", () => {
    const result = normalizeCard({
      category: [{ name: "Action" }, { name: "Drama" }],
    });
    expect(result.category).toBe("Action, Drama");
  });

  test("extracts category as label text from string", () => {
    const result = normalizeCard({ category: "Thriller" });
    expect(result.category).toBe("Thriller");
  });

  test("returns undefined for empty category", () => {
    expect(normalizeCard({ category: [] }).category).toBeUndefined();
    expect(normalizeCard({ category: "" }).category).toBeUndefined();
  });

  test("extracts country label", () => {
    const result = normalizeCard({
      country: [{ name: "Hàn Quốc" }],
    });
    expect(result.country).toBe("Hàn Quốc");
  });

  test("preserves pre-signed image URLs without modification", () => {
    const signed = "https://img.bluesia.net/i/m/abc123.webp?url=upstream&sig=v2.xyz";
    const result = normalizeCard({ thumb_url: signed });
    expect(result.thumb).toBe(signed);
  });

  test("handles TMDB id from nested object", () => {
    const result = normalizeCard({ tmdb: { id: 12345, type: "movie" } });
    expect(result.tmdb?.id).toBe(12345);
    expect(result.tmdb?.type).toBe("movie");
  });

  test("handles IMDb string id", () => {
    const result = normalizeCard({ imdb: { id: "tt1234567" } });
    expect(result.imdb?.id).toBe("tt1234567");
  });

  test("handles missing imdb/tmdb gracefully", () => {
    const result = normalizeCard({ name: "Basic" });
    expect(result.tmdb?.vote_average).toBeUndefined();
    expect(result.imdb?.rating).toBeUndefined();
  });
});
