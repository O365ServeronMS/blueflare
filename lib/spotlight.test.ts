import { describe, test, expect } from "vitest";
import {
  baseSpotlightScore,
  buildSmartSpotlight,
  splitLabels,
  normalizedLabelSet,
  TRENDING_SPOTLIGHT_BONUS,
  type SpotlightCandidate,
} from "./spotlight";
import type { MovieCard } from "./types";

function card(overrides: Partial<MovieCard> = {}): MovieCard {
  return {
    name: "Test Movie",
    slug: "test-movie",
    poster: "https://img.test/poster.webp",
    thumb: "https://img.test/thumb.webp",
    ...overrides,
  };
}

function candidate(slug: string, source: string, overrides: Partial<MovieCard> = {}, order?: number): SpotlightCandidate {
  return { movie: card({ slug, ...overrides }), source, order };
}

describe("baseSpotlightScore", () => {
  test("source bonus applies for known sources", () => {
    const cinema = baseSpotlightScore(card(), ["cinema"], 0);
    const none = baseSpotlightScore(card(), [], 0);
    expect(cinema).toBeGreaterThan(none);
  });

  test("trending bonus applies", () => {
    const trending = baseSpotlightScore(card(), [], 0, true);
    const normal = baseSpotlightScore(card(), [], 0, false);
    expect(trending - normal).toBe(TRENDING_SPOTLIGHT_BONUS);
  });

  test("high rating scores higher", () => {
    const high = baseSpotlightScore(card({ imdb: { rating: 9.0 } }), [], 0);
    const low = baseSpotlightScore(card({ imdb: { rating: 5.0 } }), [], 0);
    expect(high).toBeGreaterThan(low);
  });

  test("rating tiers are correct", () => {
    const score85 = baseSpotlightScore(card({ imdb: { rating: 8.5 } }), [], 0);
    const score80 = baseSpotlightScore(card({ imdb: { rating: 8.0 } }), [], 0);
    const score75 = baseSpotlightScore(card({ imdb: { rating: 7.5 } }), [], 0);
    const score70 = baseSpotlightScore(card({ imdb: { rating: 7.0 } }), [], 0);
    const score65 = baseSpotlightScore(card({ imdb: { rating: 6.5 } }), [], 0);
    expect(score85).toBeGreaterThan(score80);
    expect(score80).toBeGreaterThan(score75);
    expect(score75).toBeGreaterThan(score70);
    expect(score70).toBeGreaterThan(score65);
  });

  test("recent movies score higher", () => {
    const currentYear = new Date().getFullYear();
    const recent = baseSpotlightScore(card({ year: currentYear }), [], 0);
    const old = baseSpotlightScore(card({ year: currentYear - 10 }), [], 0);
    expect(recent).toBeGreaterThan(old);
  });

  test("4K quality scores higher than HD", () => {
    const uhd = baseSpotlightScore(card({ quality: "4K" }), [], 0);
    const hd = baseSpotlightScore(card({ quality: "HD" }), [], 0);
    expect(uhd).toBeGreaterThan(hd);
  });

  test("full episode status adds score", () => {
    const full = baseSpotlightScore(card({ episodeCurrent: "Full" }), [], 0);
    const ongoing = baseSpotlightScore(card({ episodeCurrent: "Tập 5" }), [], 0);
    expect(full).toBeGreaterThan(ongoing);
  });

  test("vietsub language adds score", () => {
    const vietsub = baseSpotlightScore(card({ lang: "Vietsub" }), [], 0);
    const none = baseSpotlightScore(card({ lang: "" }), [], 0);
    expect(vietsub).toBeGreaterThan(none);
  });

  test("movies with images score much higher than without", () => {
    const withImages = baseSpotlightScore(card({ thumb: "t.jpg", poster: "p.jpg" }), [], 0);
    const noImages = baseSpotlightScore(card({ thumb: "", poster: "" }), [], 0);
    expect(withImages - noImages).toBeGreaterThanOrEqual(45);
  });

  test("cinema source adds content score", () => {
    const cinema = baseSpotlightScore(card(), ["cinema"], 0);
    const series = baseSpotlightScore(card(), ["series"], 0);
    expect(cinema).toBeGreaterThan(series);
  });

  test("order 0 scores higher than order 30", () => {
    const first = baseSpotlightScore(card(), [], 0);
    const later = baseSpotlightScore(card(), [], 30);
    expect(first).toBeGreaterThan(later);
  });

  test("stable noise is deterministic for same slug", () => {
    const a = baseSpotlightScore(card({ slug: "same" }), [], 0);
    const b = baseSpotlightScore(card({ slug: "same" }), [], 0);
    expect(a).toBe(b);
  });
});

describe("buildSmartSpotlight", () => {
  test("deduplicates by slug", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("movie-a", "latest"),
      candidate("movie-a", "cinema"),
      candidate("movie-b", "latest"),
    ];
    const result = buildSmartSpotlight(candidates);
    const slugs = result.map((m) => m.slug);
    expect(slugs).toContain("movie-a");
    expect(slugs).toContain("movie-b");
    expect(result.length).toBe(2);
  });

  test("merges ratings when deduplicating", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("movie-a", "latest", { imdb: { rating: 8.0 } }),
      candidate("movie-a", "cinema", { tmdb: { vote_average: 7.5 } }),
    ];
    const result = buildSmartSpotlight(candidates);
    expect(result[0].slug).toBe("movie-a");
    const ratings = [result[0].imdb?.rating, result[0].tmdb?.vote_average];
    expect(ratings).toContain(8.0);
    expect(ratings).toContain(7.5);
  });

  test("respects limit", () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      candidate(`movie-${i}`, "latest")
    );
    const result = buildSmartSpotlight(candidates, 10);
    expect(result.length).toBe(10);
  });

  test("sorts by score descending", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("low", "latest", { imdb: { rating: 3.0 }, thumb: "", poster: "" }),
      candidate("high", "cinema", { imdb: { rating: 9.0 }, quality: "4K", year: new Date().getFullYear() }),
    ];
    const result = buildSmartSpotlight(candidates);
    expect(result[0].slug).toBe("high");
  });

  test("pins AU/MY movie first when available", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("top-rated", "cinema", { imdb: { rating: 9.5 } }),
      candidate("au-my-movie", "single-au-my", { imdb: { rating: 7.0 } }),
    ];
    const result = buildSmartSpotlight(candidates);
    expect(result[0].slug).toBe("au-my-movie");
  });

  test("AU/MY pin requires images", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("top-rated", "cinema", { imdb: { rating: 9.5 } }),
      candidate("au-my-no-image", "single-au-my", { imdb: { rating: 7.0 }, thumb: "", poster: "" }),
    ];
    const result = buildSmartSpotlight(candidates);
    expect(result[0].slug).toBe("top-rated");
  });

  test("applies trending bonus for matching TMDB IDs", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("normal", "latest", { tmdb: { id: 100 }, imdb: { rating: 7.0 } }),
      candidate("trending", "latest", { tmdb: { id: 200 }, imdb: { rating: 7.0 } }),
    ];
    const trendingIds = new Set(["200"]);
    const result = buildSmartSpotlight(candidates, 24, trendingIds);
    expect(result[0].slug).toBe("trending");
  });

  test("returns empty for empty candidates", () => {
    expect(buildSmartSpotlight([])).toEqual([]);
  });

  test("skips candidates with empty slug", () => {
    const candidates: SpotlightCandidate[] = [
      candidate("", "latest"),
      candidate("valid", "latest"),
    ];
    const result = buildSmartSpotlight(candidates);
    expect(result.length).toBe(1);
    expect(result[0].slug).toBe("valid");
  });
});

describe("splitLabels", () => {
  test("splits comma-separated values", () => {
    expect(splitLabels("Action, Drama, Comedy")).toEqual(["Action", "Drama", "Comedy"]);
  });

  test("filters empty segments", () => {
    expect(splitLabels("Action,,Drama")).toEqual(["Action", "Drama"]);
  });

  test("returns empty for empty input", () => {
    expect(splitLabels("")).toEqual([]);
    expect(splitLabels(undefined)).toEqual([]);
  });
});

describe("normalizedLabelSet", () => {
  test("normalizes and deduplicates", () => {
    const result = normalizedLabelSet("Hành Động, hành động, Comedy");
    expect(result.size).toBe(2);
    expect(result.has("hanh dong")).toBe(true);
    expect(result.has("comedy")).toBe(true);
  });

  test("returns empty set for empty input", () => {
    expect(normalizedLabelSet("").size).toBe(0);
  });
});
