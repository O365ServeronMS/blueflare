import { describe, test, expect } from "vitest";
import {
  stripHtml,
  getDisplayRatings,
  getDisplayRating,
  ratingLabel,
  normalizeEpisodeName,
} from "./utils";

describe("stripHtml", () => {
  test("removes HTML tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  test("collapses whitespace", () => {
    expect(stripHtml("<p>Hello</p>  <p>World</p>")).toBe("Hello World");
  });

  test("returns empty for undefined/null/empty", () => {
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml("")).toBe("");
  });

  test("handles nested tags", () => {
    expect(stripHtml("<div><p><span>text</span></p></div>")).toBe("text");
  });

  test("handles self-closing tags", () => {
    expect(stripHtml("before<br/>after")).toBe("before after");
  });
});

describe("getDisplayRatings", () => {
  test("extracts both TMDB and IMDb ratings", () => {
    const result = getDisplayRatings({ tmdbRating: 8.5, imdbRating: 7.3 });
    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ label: "TMDB", score: 8.5, text: "TMDB 8.5" });
    expect(result[1]).toEqual({ label: "IMDb", score: 7.3, text: "IMDb 7.3" });
  });

  test("extracts from nested tmdb/imdb objects", () => {
    const result = getDisplayRatings({
      tmdb: { vote_average: 7.0 },
      imdb: { rating: 6.5 },
    });
    expect(result.length).toBe(2);
    expect(result[0].score).toBe(7.0);
    expect(result[1].score).toBe(6.5);
  });

  test("extracts from tmdb_rating and imdb_rating flat fields", () => {
    const result = getDisplayRatings({ tmdb_rating: 8.0, imdb_rating: 7.0 });
    expect(result.length).toBe(2);
  });

  test("extracts from tmdb_vote_average and imdb_score", () => {
    const result = getDisplayRatings({ tmdb_vote_average: 7.5, imdb_score: 6.8 });
    expect(result[0].score).toBe(7.5);
    expect(result[1].score).toBe(6.8);
  });

  test("extracts from vote_average (TMDB only)", () => {
    const result = getDisplayRatings({ vote_average: 8.2 });
    expect(result.length).toBe(1);
    expect(result[0].label).toBe("TMDB");
    expect(result[0].score).toBe(8.2);
  });

  test("extracts from nested rating object", () => {
    const result = getDisplayRatings({ rating: { tmdb: 7.0, imdb: 6.0 } });
    expect(result.length).toBe(2);
  });

  test("extracts from ratings object", () => {
    const result = getDisplayRatings({ ratings: { tmdb: 7.5, imdb: 8.0 } });
    expect(result.length).toBe(2);
  });

  test("skips zero and negative ratings", () => {
    expect(getDisplayRatings({ tmdbRating: 0, imdbRating: -1 })).toEqual([]);
  });

  test("skips N/A string", () => {
    expect(getDisplayRatings({ tmdbRating: "N/A" })).toEqual([]);
  });

  test("parses string ratings", () => {
    const result = getDisplayRatings({ tmdbRating: "8.5", imdbRating: "7.2" });
    expect(result[0].score).toBe(8.5);
    expect(result[1].score).toBe(7.2);
  });

  test("returns empty for no ratings", () => {
    expect(getDisplayRatings({})).toEqual([]);
  });

  test("handles numeric rating field (non-object)", () => {
    const result = getDisplayRatings({ rating: 8.5 });
    expect(result).toEqual([]);
  });
});

describe("getDisplayRating", () => {
  test("prefers IMDb", () => {
    const result = getDisplayRating({ imdbRating: 8.0, tmdbRating: 9.0 });
    expect(result?.label).toBe("IMDb");
    expect(result?.score).toBe(8.0);
  });

  test("extracts from imdb.rating", () => {
    const result = getDisplayRating({ imdb: { rating: 7.5 } });
    expect(result?.score).toBe(7.5);
  });

  test("extracts from nested rating.imdb", () => {
    const result = getDisplayRating({ rating: { imdb: 6.8 } });
    expect(result?.score).toBe(6.8);
  });

  test("extracts from ratings.imdb", () => {
    const result = getDisplayRating({ ratings: { imdb: 7.0 } });
    expect(result?.score).toBe(7.0);
  });

  test("returns null when no valid IMDb rating", () => {
    expect(getDisplayRating({})).toBeNull();
    expect(getDisplayRating({ tmdbRating: 9.0 })).toBeNull();
  });
});

describe("ratingLabel", () => {
  test("returns formatted label", () => {
    expect(ratingLabel({ imdbRating: 8.0 })).toBe("IMDb 8");
    expect(ratingLabel({ imdbRating: 7.3 })).toBe("IMDb 7.3");
  });

  test("formats .0 without decimal", () => {
    expect(ratingLabel({ imdbRating: 9.0 })).toBe("IMDb 9");
  });

  test("returns empty string when no rating", () => {
    expect(ratingLabel({})).toBe("");
  });
});

describe("normalizeEpisodeName (legacy utils version)", () => {
  test("prefixes with Tập when missing", () => {
    expect(normalizeEpisodeName("5")).toBe("Tập 5");
  });

  test("preserves existing Tập prefix", () => {
    expect(normalizeEpisodeName("Tập 3")).toBe("Tập 3");
  });

  test("preserves lowercase tập prefix", () => {
    expect(normalizeEpisodeName("tập 2")).toBe("tập 2");
  });

  test("returns indexed fallback for empty string", () => {
    expect(normalizeEpisodeName("", 0)).toBe("Tập 1");
    expect(normalizeEpisodeName("", 4)).toBe("Tập 5");
  });

  test("returns indexed fallback for undefined", () => {
    expect(normalizeEpisodeName(undefined, 2)).toBe("Tập 3");
  });
});
