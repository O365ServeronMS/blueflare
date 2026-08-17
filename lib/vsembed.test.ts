import { describe, test, expect } from "vitest";
import {
  buildVsembedMovieUrl,
  buildVsembedEpisodeUrl,
  buildVsembedServer,
} from "./vsembed";
import type { MovieDetail } from "./types";

const BASE = "https://vsembed.ru";

function movie(overrides: Partial<MovieDetail> = {}): MovieDetail {
  return {
    name: "Test",
    slug: "test",
    poster: "",
    thumb: "",
    episodes: [],
    ...overrides,
  };
}

describe("buildVsembedMovieUrl", () => {
  test("uses TMDB ID when available", () => {
    const url = buildVsembedMovieUrl({ tmdb: { id: 12345 }, imdb: {} });
    expect(url).toBe(`${BASE}/embed/movie?tmdb=12345&autoplay=0`);
  });

  test("falls back to IMDb ID", () => {
    const url = buildVsembedMovieUrl({ tmdb: {}, imdb: { id: "tt1234567" } });
    expect(url).toBe(`${BASE}/embed/movie?imdb=tt1234567&autoplay=0`);
  });

  test("prefers TMDB over IMDb", () => {
    const url = buildVsembedMovieUrl({ tmdb: { id: 999 }, imdb: { id: "tt111" } });
    expect(url).toContain("tmdb=999");
    expect(url).not.toContain("imdb=");
  });

  test("returns empty when no ID", () => {
    expect(buildVsembedMovieUrl({ tmdb: {}, imdb: {} })).toBe("");
  });

  test("returns empty when TMDB id is empty string", () => {
    expect(buildVsembedMovieUrl({ tmdb: { id: "" as any }, imdb: {} })).toBe("");
  });

  test("returns empty when IMDb id is invalid format", () => {
    expect(buildVsembedMovieUrl({ tmdb: {}, imdb: { id: "invalid" } })).toBe("");
  });

  test("accepts string TMDB ID", () => {
    const url = buildVsembedMovieUrl({ tmdb: { id: "555" as any }, imdb: {} });
    expect(url).toContain("tmdb=555");
  });
});

describe("buildVsembedEpisodeUrl", () => {
  test("builds TV embed URL with season and episode", () => {
    const url = buildVsembedEpisodeUrl({ tmdb: { id: 100 }, imdb: {} }, 2, 5);
    expect(url).toBe(`${BASE}/embed/tv?tmdb=100&season=2&episode=5&autoplay=0&autonext=1`);
  });

  test("clamps season and episode to minimum 1", () => {
    const url = buildVsembedEpisodeUrl({ tmdb: { id: 100 }, imdb: {} }, 0, -1);
    expect(url).toContain("season=1");
    expect(url).toContain("episode=1");
  });

  test("returns empty when no ID", () => {
    expect(buildVsembedEpisodeUrl({ tmdb: {}, imdb: {} }, 1, 1)).toBe("");
  });

  test("uses IMDb fallback", () => {
    const url = buildVsembedEpisodeUrl({ tmdb: {}, imdb: { id: "tt999" } }, 1, 3);
    expect(url).toContain("imdb=tt999");
    expect(url).toContain("episode=3");
  });
});

describe("buildVsembedServer", () => {
  test("returns null when no identity", () => {
    expect(buildVsembedServer(movie({ tmdb: {}, imdb: {} }))).toBeNull();
  });

  test("returns single-episode server for phim-le", () => {
    const result = buildVsembedServer(movie({
      type: "single",
      tmdb: { id: 500 },
      imdb: {},
    }));
    expect(result).not.toBeNull();
    expect(result!.serverName).toBe("Vidsrc");
    expect(result!.serverData.length).toBe(1);
    expect(result!.serverData[0].name).toBe("Full");
    expect(result!.serverData[0].slug).toBe("vsembed-full");
    expect(result!.serverData[0].linkEmbed).toContain("/embed/movie");
  });

  test("returns single-episode for episodeTotal=Full", () => {
    const result = buildVsembedServer(movie({
      episodeTotal: "Full",
      tmdb: { id: 500 },
      imdb: {},
    }));
    expect(result!.serverData[0].linkEmbed).toContain("/embed/movie");
  });

  test("returns single-episode for episodeTotal=1", () => {
    const result = buildVsembedServer(movie({
      episodeTotal: "1",
      tmdb: { id: 500 },
      imdb: {},
    }));
    expect(result!.serverData[0].linkEmbed).toContain("/embed/movie");
  });

  test("mirrors episode structure for series", () => {
    const result = buildVsembedServer(movie({
      type: "series",
      tmdb: { id: 200 },
      imdb: {},
      episodes: [{
        serverName: "Primary",
        serverData: [
          { name: "Tập 1", slug: "tap-1" },
          { name: "Tập 2", slug: "tap-2" },
          { name: "Tập 3", slug: "tap-3" },
        ],
      }],
    }));
    expect(result).not.toBeNull();
    expect(result!.serverData.length).toBe(3);
    expect(result!.serverData[0].slug).toBe("vsembed-tap-1");
    expect(result!.serverData[0].linkEmbed).toContain("episode=1");
    expect(result!.serverData[2].linkEmbed).toContain("episode=3");
  });

  test("extracts episode number from slug pattern", () => {
    const result = buildVsembedServer(movie({
      type: "series",
      tmdb: { id: 200 },
      imdb: {},
      episodes: [{
        serverName: "S",
        serverData: [{ name: "Tập 05", slug: "tap-05" }],
      }],
    }));
    expect(result!.serverData[0].linkEmbed).toContain("episode=5");
  });

  test("preserves filename from source episodes", () => {
    const result = buildVsembedServer(movie({
      type: "series",
      tmdb: { id: 200 },
      imdb: {},
      episodes: [{
        serverName: "S",
        serverData: [{ name: "Tập 1", slug: "tap-1", filename: "ep01.mp4" }],
      }],
    }));
    expect(result!.serverData[0].filename).toBe("ep01.mp4");
  });

  test("returns single-episode when episodes array is empty (no episodes to mirror)", () => {
    const result = buildVsembedServer(movie({
      type: "series",
      tmdb: { id: 200 },
      imdb: {},
      episodes: [],
    }));
    expect(result!.serverData[0].linkEmbed).toContain("/embed/movie");
  });

  test("generates vsembed-N slug when episode has no slug", () => {
    const result = buildVsembedServer(movie({
      type: "series",
      tmdb: { id: 200 },
      imdb: {},
      episodes: [{
        serverName: "S",
        serverData: [{ name: "Episode 1" }],
      }],
    }));
    expect(result!.serverData[0].slug).toBe("vsembed-1");
  });
});
