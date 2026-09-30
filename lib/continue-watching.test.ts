import { describe, expect, test } from "vitest";
import { formatClock, nextEpisodeTarget, parseContinueItem, resumeTarget, type ContinueItem } from "@/lib/continue-watching";

const item = (over: Partial<ContinueItem> = {}): ContinueItem => ({
  slug: "s", episodeKey: "tap-2", positionSec: 600, durationSec: 2400, progress: 0.25, ...over,
});

describe("resumeTarget", () => {
  test("resumes the matching episode inside 0.02..0.9", () => {
    expect(resumeTarget(item(), "tap-2")).toBe(600);
    expect(resumeTarget(item({ progress: 0.02, positionSec: 48 }), "tap-2")).toBe(48);
  });
  test("rejects other episodes and out-of-range progress", () => {
    expect(resumeTarget(item(), "tap-3")).toBeNull();
    expect(resumeTarget(item({ progress: 0.019 }), "tap-2")).toBeNull();
    expect(resumeTarget(item({ progress: 0.9 }), "tap-2")).toBeNull();
    expect(resumeTarget(null, "tap-2")).toBeNull();
  });
});

describe("nextEpisodeTarget", () => {
  const next = item({ progress: 0, positionSec: 0, durationSec: 0, episodeKey: "tap-3" });
  test("suggests a known, different episode at progress 0", () => {
    expect(nextEpisodeTarget(next, "tap-2", ["tap-2", "tap-3"])).toBe("tap-3");
  });
  test("ignores same episode, unknown key, or in-progress items", () => {
    expect(nextEpisodeTarget(next, "tap-3", ["tap-3"])).toBeNull();
    expect(nextEpisodeTarget(next, "tap-2", ["tap-2"])).toBeNull();
    expect(nextEpisodeTarget(item(), "tap-1", ["tap-1", "tap-2"])).toBeNull();
  });
});

describe("parseContinueItem", () => {
  const body = { items: [{ movie: { slug: "a" } , episodeKey: "e", positionSec: 5, durationSec: 100, progress: 0.05 }, { movie: { slug: "s" }, episodeKey: "e2", positionSec: 9, durationSec: 90, progress: 0.1 }] };
  test("picks the item by slug", () => {
    expect(parseContinueItem(body, "s")).toEqual({ slug: "s", episodeKey: "e2", positionSec: 9, durationSec: 90, progress: 0.1 });
  });
  test("returns null for missing or malformed data", () => {
    expect(parseContinueItem(body, "zzz")).toBeNull();
    expect(parseContinueItem(null, "s")).toBeNull();
    expect(parseContinueItem({ items: [{ movie: { slug: "s" }, episodeKey: "e", positionSec: "x" }] }, "s")).toBeNull();
  });
});

describe("formatClock", () => {
  test("formats mm:ss and h:mm:ss", () => {
    expect(formatClock(75)).toBe("01:15");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(NaN)).toBe("00:00");
  });
});

import { continueCardHref, parseContinueEntries } from "@/lib/continue-watching";

describe("continue row helpers", () => {
  const raw = (slug: string, over = {}) => ({
    movie: { slug, name: slug },
    episodeKey: "tap-2", positionSec: 600, durationSec: 2400, progress: 0.25, updatedAt: "x", ...over,
  });
  test("parses valid rows, drops junk and duplicates", () => {
    const out = parseContinueEntries({ items: [raw("a"), raw("a"), { movie: {} }, raw("b", { progress: "x" }), raw("c", { progress: 0 })] });
    expect(out.map((e) => e.movie.slug)).toEqual(["a", "c"]);
    expect(parseContinueEntries(null)).toEqual([]);
  });
  test("href resumes only mid-episode; next-episode suggestion has no resume", () => {
    const [a, c] = parseContinueEntries({ items: [raw("a"), raw("c", { progress: 0 })] });
    expect(continueCardHref(a.item, "/")).toBe("/movie/a?ep=tap-2&play=1&resume=1&returnTo=%2F#player");
    expect(continueCardHref(c.item, "/")).toBe("/movie/c?ep=tap-2&play=1&returnTo=%2F#player");
  });
});
