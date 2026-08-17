import { describe, test, expect } from "vitest";
import {
  normalizedEpisodeName,
  normalizedEpisodeSlug,
  episodeWatchKey,
  findEpisodeByWatchKey,
} from "./episodes";
import type { Episode, EpisodeServer } from "./types";

describe("normalizedEpisodeName", () => {
  test("returns name when meaningful", () => {
    expect(normalizedEpisodeName({ name: "Tập 5" }, 4)).toBe("Tập 5");
  });

  test("returns filename when name is generic 'Tập phim'", () => {
    expect(normalizedEpisodeName({ name: "Tập phim", filename: "Episode 3" }, 2)).toBe("Episode 3");
  });

  test("returns filename when name is generic (Vietnamese)", () => {
    expect(normalizedEpisodeName({ name: "Tập phim", filename: "Ep3" }, 0)).toBe("Ep3");
  });

  test("returns Full when slug is full and name is generic", () => {
    expect(normalizedEpisodeName({ name: "", slug: "full" }, 0)).toBe("Full");
  });

  test("returns indexed fallback when no data", () => {
    expect(normalizedEpisodeName({}, 0)).toBe("Tap 1");
    expect(normalizedEpisodeName({}, 4)).toBe("Tap 5");
  });

  test("returns indexed fallback when name is empty and no slug/filename", () => {
    expect(normalizedEpisodeName({ name: "" }, 2)).toBe("Tap 3");
  });

  test("returns name when it is non-generic even without Tập prefix", () => {
    expect(normalizedEpisodeName({ name: "Pilot" }, 0)).toBe("Pilot");
  });
});

describe("normalizedEpisodeSlug", () => {
  test("returns slug when present", () => {
    expect(normalizedEpisodeSlug({ slug: "tap-5" }, 4)).toBe("tap-5");
  });

  test("returns full for Full name", () => {
    expect(normalizedEpisodeSlug({ name: "", slug: "full" }, 0)).toBe("full");
  });

  test("returns ep-N fallback", () => {
    expect(normalizedEpisodeSlug({}, 0)).toBe("ep-1");
    expect(normalizedEpisodeSlug({}, 3)).toBe("ep-4");
  });

  test("returns slug over generated fallback", () => {
    expect(normalizedEpisodeSlug({ slug: "custom-slug", name: "Pilot" }, 0)).toBe("custom-slug");
  });
});

describe("episodeWatchKey", () => {
  test("uses slug when meaningful", () => {
    expect(episodeWatchKey({ name: "Tập 1", slug: "tap-1" }, 0)).toBe("tap-1");
  });

  test("returns full for Full episode", () => {
    expect(episodeWatchKey({ name: "Full", slug: "" }, 0)).toBe("full");
  });

  test("returns index string when slug is generic", () => {
    expect(episodeWatchKey({ name: "Tập 3", slug: "tập phim" }, 2)).toBe("2");
  });

  test("returns index for empty slug and non-Full name", () => {
    expect(episodeWatchKey({ name: "Episode 1", slug: "" }, 0)).toBe("0");
  });
});

describe("findEpisodeByWatchKey", () => {
  const episodes: Episode[] = [
    { name: "Tập 1", slug: "tap-1" },
    { name: "Tập 2", slug: "tap-2" },
    { name: "Tập 3", slug: "tap-3" },
  ];
  const server: EpisodeServer = { serverName: "Test", serverData: episodes };

  test("returns first episode when key is empty", () => {
    expect(findEpisodeByWatchKey(server, "")).toBe(episodes[0]);
    expect(findEpisodeByWatchKey(server, undefined)).toBe(episodes[0]);
  });

  test("finds by slug", () => {
    expect(findEpisodeByWatchKey(server, "tap-2")).toBe(episodes[1]);
  });

  test("finds by name", () => {
    expect(findEpisodeByWatchKey(server, "Tập 3")).toBe(episodes[2]);
  });

  test("finds by numeric index", () => {
    expect(findEpisodeByWatchKey(server, "1")).toBe(episodes[1]);
  });

  test("falls back to first episode for unknown key", () => {
    expect(findEpisodeByWatchKey(server, "nonexistent")).toBe(episodes[0]);
  });

  test("returns undefined for empty server", () => {
    expect(findEpisodeByWatchKey({ serverName: "Empty", serverData: [] }, "tap-1")).toBeUndefined();
  });

  test("returns undefined when server is undefined", () => {
    expect(findEpisodeByWatchKey(undefined, "tap-1")).toBeUndefined();
  });

  test("returns single episode for generic key when only one episode", () => {
    const single: EpisodeServer = { serverName: "S", serverData: [{ name: "Full", slug: "full" }] };
    expect(findEpisodeByWatchKey(single, "tập phim")).toBe(single.serverData[0]);
  });

  test("finds by filename", () => {
    const withFilename: EpisodeServer = {
      serverName: "S",
      serverData: [{ name: "Tập 1", slug: "tap-1", filename: "ep01.mp4" }],
    };
    expect(findEpisodeByWatchKey(withFilename, "ep01.mp4")).toBe(withFilename.serverData[0]);
  });

  test("rejects out-of-bounds numeric index", () => {
    expect(findEpisodeByWatchKey(server, "99")).toBe(episodes[0]);
  });
});
