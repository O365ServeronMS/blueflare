import { describe, test, expect } from "vitest";
import { absoluteImageUrl, nextImageFallback } from "./image-fallback";

const BASE = "https://phim.bluesia.net/list/phim-bo?page=731";
const PORTRAIT = "https://img.bluesia.net/i/m/10d54f2d-ad8d-4287-b526-3523ed94843e.webp";
const LANDSCAPE = "https://img.bluesia.net/i/d/10d54f2d-ad8d-4287-b526-3523ed94843e.webp";
const PLACEHOLDER = "/image-placeholder.svg";

describe("absoluteImageUrl", () => {
  test("resolves a root-relative placeholder against the page", () => {
    expect(absoluteImageUrl(PLACEHOLDER, BASE)).toBe("https://phim.bluesia.net/image-placeholder.svg");
  });

  test("keeps an absolute URL intact", () => {
    expect(absoluteImageUrl(PORTRAIT, BASE)).toBe(PORTRAIT);
  });

  // With a base, URL() treats almost any string as a relative path, so this
  // resolves rather than throwing. The try/catch only guards a malformed base.
  test("resolves an odd source relative to the page instead of throwing", () => {
    expect(absoluteImageUrl("::not a url::", BASE)).toBe("https://phim.bluesia.net/list/::not%20a%20url::");
  });

  test("returns empty string when the base itself is unusable", () => {
    expect(absoluteImageUrl(PLACEHOLDER, "not-a-base")).toBe("");
  });
});

describe("nextImageFallback", () => {
  test("skips undefined candidates", () => {
    expect(nextImageFallback([undefined, LANDSCAPE], new Set(), BASE)).toBe(LANDSCAPE);
  });

  test("returns the first candidate that has not been attempted", () => {
    const attempted = new Set([PORTRAIT]);
    expect(nextImageFallback([LANDSCAPE, PORTRAIT, PLACEHOLDER], attempted, BASE)).toBe(LANDSCAPE);
  });

  test("falls through to the placeholder once both variants failed", () => {
    const attempted = new Set([PORTRAIT, LANDSCAPE]);
    expect(nextImageFallback([LANDSCAPE, PORTRAIT, PLACEHOLDER], attempted, BASE))
      .toBe("https://phim.bluesia.net/image-placeholder.svg");
  });

  test("returns empty string when every candidate was already attempted", () => {
    const attempted = new Set([PORTRAIT, LANDSCAPE, "https://phim.bluesia.net/image-placeholder.svg"]);
    expect(nextImageFallback([LANDSCAPE, PORTRAIT, PLACEHOLDER], attempted, BASE)).toBe("");
  });

  // Regression: a missing asset 404s for both signed variants. Walking the chain
  // must terminate at the placeholder rather than ping-pong m -> d -> m forever.
  test("a fully missing asset terminates after three attempts", () => {
    const attempted = new Set<string>();
    const candidates = [LANDSCAPE, PORTRAIT, PLACEHOLDER];
    const walked: string[] = [];

    attempted.add(PORTRAIT); // the initial src that failed first
    for (let guard = 0; guard < 10; guard += 1) {
      const next = nextImageFallback(candidates, attempted, BASE);
      if (!next) break;
      walked.push(next);
      attempted.add(next);
    }

    expect(walked).toEqual([LANDSCAPE, "https://phim.bluesia.net/image-placeholder.svg"]);
  });
});
