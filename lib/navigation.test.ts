import { describe, test, expect } from "vitest";
import {
  normalizeNavPath,
  normalizePage,
  pageFromSearchParams,
  hrefWithPage,
  validNavSourceKey,
  navSourceFromSearchParams,
  safeInternalPath,
  isSafeInternalPath,
  createReturnToPath,
  returnToFromSearchParams,
  getSafeReturnTo,
  fallbackReturnToForSource,
  getFallbackListPath,
  getMovieBackHref,
  getBackHref,
  navSourceFromReturnTo,
  hrefWithReturnTo,
  navSourceFromPath,
  inferNavSourceFromMovie,
  getActiveNavKey,
} from "./navigation";

describe("normalizeNavPath", () => {
  test("strips trailing slash", () => {
    expect(normalizeNavPath("/list/phim-le/")).toBe("/list/phim-le");
  });

  test("preserves single slash", () => {
    expect(normalizeNavPath("/")).toBe("/");
  });

  test("returns / for empty string", () => {
    expect(normalizeNavPath("")).toBe("/");
  });

  test("leaves clean path unchanged", () => {
    expect(normalizeNavPath("/movie/test")).toBe("/movie/test");
  });
});

describe("normalizePage", () => {
  test("returns 1 for undefined", () => {
    expect(normalizePage(undefined)).toBe(1);
  });

  test("returns 1 for null", () => {
    expect(normalizePage(null)).toBe(1);
  });

  test("returns 1 for NaN string", () => {
    expect(normalizePage("abc")).toBe(1);
  });

  test("returns 1 for negative number", () => {
    expect(normalizePage(-5)).toBe(1);
  });

  test("returns 1 for zero", () => {
    expect(normalizePage(0)).toBe(1);
  });

  test("floors float to integer", () => {
    expect(normalizePage(3.7)).toBe(3);
  });

  test("parses valid numeric string", () => {
    expect(normalizePage("5")).toBe(5);
  });

  test("trims whitespace", () => {
    expect(normalizePage(" 3 ")).toBe(3);
  });

  test("accepts number type", () => {
    expect(normalizePage(10)).toBe(10);
  });

  test("returns 1 for Infinity", () => {
    expect(normalizePage(Infinity)).toBe(1);
  });

  test("returns 1 for empty string", () => {
    expect(normalizePage("")).toBe(1);
  });
});

describe("pageFromSearchParams", () => {
  test("returns 1 when no params", () => {
    expect(pageFromSearchParams(null)).toBe(1);
    expect(pageFromSearchParams(undefined)).toBe(1);
  });

  test("extracts page from URLSearchParams", () => {
    expect(pageFromSearchParams(new URLSearchParams("page=3"))).toBe(3);
  });

  test("extracts page from string", () => {
    expect(pageFromSearchParams("page=5")).toBe(5);
  });

  test("handles leading ? in string", () => {
    expect(pageFromSearchParams("?page=2")).toBe(2);
  });

  test("returns 1 when page param missing", () => {
    expect(pageFromSearchParams("type=phim-le")).toBe(1);
  });
});

describe("hrefWithPage", () => {
  test("adds page param", () => {
    expect(hrefWithPage("/list/phim-le", "", 3)).toBe("/list/phim-le?page=3");
  });

  test("strips page=1", () => {
    expect(hrefWithPage("/list/phim-le", "", 1)).toBe("/list/phim-le");
  });

  test("retains existing query params", () => {
    const result = hrefWithPage("/search", "keyword=test", 2);
    expect(result).toContain("keyword=test");
    expect(result).toContain("page=2");
  });

  test("normalizes trailing slash", () => {
    expect(hrefWithPage("/list/phim-le/", "", 2)).toBe("/list/phim-le?page=2");
  });

  test("handles search string with ?", () => {
    expect(hrefWithPage("/list/phim-le", "?type=movie", 2)).toContain("page=2");
  });
});

describe("validNavSourceKey", () => {
  test("accepts valid keys", () => {
    expect(validNavSourceKey("home")).toBe("home");
    expect(validNavSourceKey("phim-le")).toBe("phim-le");
    expect(validNavSourceKey("phim-bo")).toBe("phim-bo");
    expect(validNavSourceKey("tv-shows")).toBe("tv-shows");
    expect(validNavSourceKey("hoat-hinh")).toBe("hoat-hinh");
  });

  test("returns empty for invalid key", () => {
    expect(validNavSourceKey("invalid")).toBe("");
    expect(validNavSourceKey("")).toBe("");
    expect(validNavSourceKey(null)).toBe("");
    expect(validNavSourceKey(undefined)).toBe("");
  });

  test("trims whitespace", () => {
    expect(validNavSourceKey(" home ")).toBe("home");
  });
});

describe("safeInternalPath", () => {
  test("accepts valid internal paths", () => {
    expect(safeInternalPath("/")).toBe("/");
    expect(safeInternalPath("/list/phim-le")).toBe("/list/phim-le");
    expect(safeInternalPath("/movie/test?returnTo=/")).toContain("/movie/test");
  });

  test("rejects protocol-relative URLs (open redirect)", () => {
    expect(safeInternalPath("//evil.com")).toBe("");
    expect(safeInternalPath("//evil.com/path")).toBe("");
  });

  test("rejects backslash paths", () => {
    expect(safeInternalPath("/path\\evil")).toBe("");
  });

  test("rejects control characters", () => {
    expect(safeInternalPath("/path\x00evil")).toBe("");
    expect(safeInternalPath("/path\nevil")).toBe("");
    expect(safeInternalPath("/path\revil")).toBe("");
  });

  test("rejects non-root paths", () => {
    expect(safeInternalPath("relative")).toBe("");
    expect(safeInternalPath("")).toBe("");
  });

  test("rejects paths that resolve to different origins", () => {
    expect(safeInternalPath("https://evil.com/path")).toBe("");
  });

  test("returns empty for null/undefined", () => {
    expect(safeInternalPath(null)).toBe("");
    expect(safeInternalPath(undefined)).toBe("");
  });

  test("preserves query params", () => {
    const result = safeInternalPath("/search?keyword=test&page=2");
    expect(result).toContain("keyword=test");
    expect(result).toContain("page=2");
  });

  test("strips hash fragments", () => {
    const result = safeInternalPath("/movie/test#section");
    expect(result).toBe("/movie/test");
  });
});

describe("isSafeInternalPath", () => {
  test("returns true for valid paths", () => {
    expect(isSafeInternalPath("/")).toBe(true);
  });

  test("returns false for dangerous paths", () => {
    expect(isSafeInternalPath("//evil.com")).toBe(false);
  });
});

describe("createReturnToPath", () => {
  test("creates path with search", () => {
    const result = createReturnToPath("/list/phim-le", "page=2");
    expect(result).toBe("/list/phim-le?page=2");
  });

  test("creates path without search", () => {
    expect(createReturnToPath("/list/phim-le")).toBe("/list/phim-le");
  });

  test("normalizes trailing slash", () => {
    expect(createReturnToPath("/list/phim-le/")).toBe("/list/phim-le");
  });

  test("handles search with leading ?", () => {
    const result = createReturnToPath("/list/phim-le", "?page=2");
    expect(result).toBe("/list/phim-le?page=2");
  });
});

describe("returnToFromSearchParams / getSafeReturnTo", () => {
  test("extracts returnTo param", () => {
    const params = new URLSearchParams("returnTo=/list/phim-le?page=2");
    const result = returnToFromSearchParams(params);
    expect(result).toContain("/list/phim-le");
  });

  test("rejects unsafe returnTo", () => {
    const params = new URLSearchParams("returnTo=//evil.com");
    expect(returnToFromSearchParams(params)).toBe("");
  });

  test("getSafeReturnTo returns null when missing", () => {
    expect(getSafeReturnTo(null)).toBeNull();
    expect(getSafeReturnTo(new URLSearchParams(""))).toBeNull();
  });

  test("getSafeReturnTo returns path when valid", () => {
    const params = new URLSearchParams("returnTo=/list/phim-bo");
    expect(getSafeReturnTo(params)).toBe("/list/phim-bo");
  });
});

describe("fallbackReturnToForSource", () => {
  test("maps each source to its list path", () => {
    expect(fallbackReturnToForSource("phim-le")).toBe("/list/phim-le");
    expect(fallbackReturnToForSource("phim-bo")).toBe("/list/phim-bo");
    expect(fallbackReturnToForSource("tv-shows")).toBe("/list/tv-shows");
    expect(fallbackReturnToForSource("hoat-hinh")).toBe("/list/hoat-hinh");
    expect(fallbackReturnToForSource("home")).toBe("/");
  });

  test("returns empty for unknown source", () => {
    expect(fallbackReturnToForSource("unknown")).toBe("");
    expect(fallbackReturnToForSource(null)).toBe("");
  });
});

describe("getFallbackListPath", () => {
  test("uses source when valid", () => {
    expect(getFallbackListPath({ source: "phim-le" })).toBe("/list/phim-le");
  });

  test("falls back to fallbackPath", () => {
    expect(getFallbackListPath({ fallbackPath: "/search" })).toBe("/search");
  });

  test("defaults to /", () => {
    expect(getFallbackListPath()).toBe("/");
    expect(getFallbackListPath({})).toBe("/");
  });

  test("rejects unsafe fallbackPath", () => {
    expect(getFallbackListPath({ fallbackPath: "//evil.com" })).toBe("/");
  });
});

describe("getMovieBackHref / getBackHref", () => {
  test("prefers returnTo from search params", () => {
    const params = new URLSearchParams("returnTo=/list/phim-le?page=3");
    const result = getMovieBackHref(params);
    expect(result).toContain("/list/phim-le");
  });

  test("falls back to source context", () => {
    const result = getMovieBackHref(new URLSearchParams(""), { source: "phim-bo" });
    expect(result).toBe("/list/phim-bo");
  });

  test("getBackHref delegates to getMovieBackHref", () => {
    const params = new URLSearchParams("returnTo=/");
    expect(getBackHref(params)).toBe("/");
  });
});

describe("navSourceFromReturnTo", () => {
  test("extracts source from returnTo path", () => {
    expect(navSourceFromReturnTo("/list/phim-le?page=2")).toBe("phim-le");
    expect(navSourceFromReturnTo("/list/hoat-hinh")).toBe("hoat-hinh");
    expect(navSourceFromReturnTo("/")).toBe("home");
  });

  test("returns empty for invalid returnTo", () => {
    expect(navSourceFromReturnTo("//evil.com")).toBe("");
    expect(navSourceFromReturnTo(null)).toBe("");
  });
});

describe("navSourceFromSearchParams", () => {
  test("prefers returnTo over from param", () => {
    const params = new URLSearchParams("returnTo=/list/phim-le&from=hoat-hinh");
    expect(navSourceFromSearchParams(params)).toBe("phim-le");
  });

  test("falls back to from param", () => {
    const params = new URLSearchParams("from=hoat-hinh");
    expect(navSourceFromSearchParams(params)).toBe("hoat-hinh");
  });

  test("returns empty when nothing present", () => {
    expect(navSourceFromSearchParams(null)).toBe("");
    expect(navSourceFromSearchParams(new URLSearchParams(""))).toBe("");
  });
});

describe("hrefWithReturnTo", () => {
  test("appends returnTo param", () => {
    const result = hrefWithReturnTo("/movie/test", "/list/phim-le?page=2");
    expect(result).toContain("returnTo=");
    expect(result).toContain("/movie/test");
  });

  test("preserves existing returnTo on target", () => {
    const result = hrefWithReturnTo("/movie/test?returnTo=/list/phim-bo", "/list/phim-le");
    const url = new URL(result, "https://phim.bluesia.net");
    expect(decodeURIComponent(url.searchParams.get("returnTo")!)).toBe("/list/phim-bo");
  });

  test("uses fallbackSource when no returnTo", () => {
    const result = hrefWithReturnTo("/movie/test", null, "phim-le");
    expect(result).toContain("returnTo=");
  });

  test("returns href unchanged when no context", () => {
    expect(hrefWithReturnTo("/movie/test", null, null)).toBe("/movie/test");
  });

  test("removes from param when returnTo is set", () => {
    const result = hrefWithReturnTo("/movie/test?from=phim-le", "/list/phim-le");
    const url = new URL(result, "https://phim.bluesia.net");
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("returnTo")).toBe(true);
  });
});

describe("navSourceFromPath", () => {
  test("recognizes home", () => {
    expect(navSourceFromPath("/")).toBe("home");
  });

  test("recognizes list paths", () => {
    expect(navSourceFromPath("/list/phim-le")).toBe("phim-le");
    expect(navSourceFromPath("/list/phim-bo")).toBe("phim-bo");
    expect(navSourceFromPath("/list/tv-shows")).toBe("tv-shows");
    expect(navSourceFromPath("/list/hoat-hinh")).toBe("hoat-hinh");
  });

  test("recognizes legacy short paths", () => {
    expect(navSourceFromPath("/phim-le")).toBe("phim-le");
    expect(navSourceFromPath("/phim-bo")).toBe("phim-bo");
    expect(navSourceFromPath("/tv-shows")).toBe("tv-shows");
    expect(navSourceFromPath("/hoat-hinh")).toBe("hoat-hinh");
  });

  test("recognizes /tv-show (singular)", () => {
    expect(navSourceFromPath("/tv-show")).toBe("tv-shows");
  });

  test("returns empty for unrecognized paths", () => {
    expect(navSourceFromPath("/movie/test")).toBe("");
    expect(navSourceFromPath("/search")).toBe("");
    expect(navSourceFromPath("/settings")).toBe("");
  });
});

describe("inferNavSourceFromMovie", () => {
  test("detects animation from category", () => {
    expect(inferNavSourceFromMovie({
      categoryList: [{ name: "Hoạt Hình", slug: "hoat-hinh" }],
      episodes: [],
    })).toBe("hoat-hinh");
  });

  test("detects animation from type", () => {
    expect(inferNavSourceFromMovie({ type: "hoathinh", episodes: [] })).toBe("hoat-hinh");
  });

  test("detects tv-shows", () => {
    expect(inferNavSourceFromMovie({
      categoryList: [{ name: "TV Shows", slug: "tv-shows" }],
      episodes: [],
    })).toBe("tv-shows");
  });

  test("detects phim-bo from series type", () => {
    expect(inferNavSourceFromMovie({ type: "series", episodes: [] })).toBe("phim-bo");
  });

  test("detects phim-le from single type", () => {
    expect(inferNavSourceFromMovie({ type: "single", episodes: [] })).toBe("phim-le");
  });

  test("detects phim-le from episodeTotal=1", () => {
    expect(inferNavSourceFromMovie({ episodeTotal: "1", episodes: [] })).toBe("phim-le");
  });

  test("detects phim-le from episodeTotal=Full", () => {
    expect(inferNavSourceFromMovie({ episodeTotal: "Full", episodes: [] })).toBe("phim-le");
  });

  test("returns empty when no signal", () => {
    expect(inferNavSourceFromMovie({ episodes: [] })).toBe("");
    expect(inferNavSourceFromMovie(null)).toBe("");
    expect(inferNavSourceFromMovie(undefined)).toBe("");
  });
});

describe("getActiveNavKey", () => {
  test("returns home for /", () => {
    expect(getActiveNavKey("/")).toBe("home");
  });

  test("returns source for list paths", () => {
    expect(getActiveNavKey("/list/phim-le")).toBe("phim-le");
  });

  test("returns search for /search", () => {
    expect(getActiveNavKey("/search")).toBe("search");
  });

  test("returns settings for /settings", () => {
    expect(getActiveNavKey("/settings")).toBe("settings");
  });

  test("resolves movie child route from searchParams", () => {
    const params = new URLSearchParams("returnTo=/list/phim-bo");
    expect(getActiveNavKey("/movie/test", params)).toBe("phim-bo");
  });

  test("resolves movie child route from movie data", () => {
    expect(getActiveNavKey("/movie/test", null, {
      type: "single",
      episodes: [],
    })).toBe("phim-le");
  });

  test("returns empty for unrecognized path without context", () => {
    expect(getActiveNavKey("/unknown")).toBe("");
  });
});
