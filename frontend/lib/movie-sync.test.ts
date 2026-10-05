import { describe, expect, test } from "vitest";
import type { MovieCard } from "@/lib/types";
import {
  buildImportPayload,
  chunk,
  missingSlugs,
  parseCardsResponse,
  parseServerItems,
  pushGuestHistory,
  pushToHead,
  toEpisodeRef,
  toSlugEntries,
  releaseLock,
  removeSlug,
  resolveCards,
  runOptimistic,
  shouldImport,
  toSavedAtMs,
  tryAcquireLock,
  upsertCard,
} from "@/lib/movie-sync";

const card = (slug: string) => ({ slug, name: slug, poster: "", thumb: "" }) as MovieCard;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("import payload", () => {
  test("keeps slug+savedAt only, dedupes, newest first, caps at 100", () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ slug: `m${i}`, savedAt: i, name: "x" }));
    const payload = buildImportPayload([{ slug: "a", savedAt: 1 }, { slug: "a", savedAt: 9 }, { slug: "b", savedAt: 5 }], many);
    expect(payload.favorites).toEqual([{ slug: "b", savedAt: 5 }, { slug: "a", savedAt: 1 }]);
    expect(payload.history).toHaveLength(100);
    expect(payload.history[0]).toEqual({ slug: "m129", savedAt: 129 });
    expect(Object.keys(payload.history[0])).toEqual(["slug", "savedAt"]);
  });
  test("skips malformed rows", () => {
    expect(buildImportPayload([{ slug: 3 }, {}, { slug: "" }], []).favorites).toEqual([]);
  });
});

describe("server mapping", () => {
  test("parses savedAt ISO and watchedAt", () => {
    const out = parseServerItems({ items: [{ slug: "a", savedAt: "2026-01-01T00:00:00.000Z" }, { slug: "b", watchedAt: 5 }] });
    expect(out).toEqual([{ slug: "a", savedAt: Date.parse("2026-01-01T00:00:00.000Z") }, { slug: "b", savedAt: 5 }].sort((x, y) => y.savedAt - x.savedAt));
  });
  test("tolerates bad bodies", () => {
    expect(parseServerItems(null)).toEqual([]);
    expect(parseServerItems({ items: "x" })).toEqual([]);
    expect(toSavedAtMs("nope", 7)).toBe(7);
  });
  test("resolves cards and drops unknown slugs", () => {
    const cache = upsertCard({}, card("a"));
    expect(resolveCards([{ slug: "a", savedAt: 3 }, { slug: "zz", savedAt: 2 }], cache)).toEqual([{ ...card("a"), savedAt: 3 }]);
  });
  test("card cache evicts oldest beyond the limit", () => {
    let cache = {};
    for (const s of ["a", "b", "c"]) cache = upsertCard(cache, card(s), 2);
    expect(Object.keys(cache)).toEqual(["b", "c"]);
    expect(Object.keys(upsertCard(cache, card("b"), 2))).toEqual(["c", "b"]);
  });
  test("list helpers", () => {
    const list = pushToHead([{ slug: "a", savedAt: 1 }, { slug: "b", savedAt: 2 }], "b", 9);
    expect(list.map((e) => e.slug)).toEqual(["b", "a"]);
    expect(removeSlug(list, "a").map((e) => e.slug)).toEqual(["b"]);
  });
});

describe("runOptimistic", () => {
  test("applies next, keeps it on success", async () => {
    let state = "old";
    const ok = await runOptimistic({ previous: "old", next: "new", apply: (v) => (state = v), request: async () => true });
    expect(ok).toBe(true);
    expect(state).toBe("new");
  });
  test("rolls back on failure and on thrown errors", async () => {
    let state = "old";
    await runOptimistic({ previous: "old", next: "new", apply: (v) => (state = v), request: async () => false });
    expect(state).toBe("old");
    await runOptimistic({ previous: "old", next: "new", apply: (v) => (state = v), request: async () => { throw new Error("net"); } });
    expect(state).toBe("old");
  });
  test("does not roll back over a newer write", async () => {
    let state = "old";
    await runOptimistic({ previous: "old", next: "new", apply: (v) => (state = v), request: async () => { state = "newer"; return false; }, isCurrent: () => state === "new" });
    expect(state).toBe("newer");
  });
});

describe("import lock", () => {
  test("second owner is blocked until release or expiry", () => {
    const store = memoryStore();
    expect(tryAcquireLock(store, "k", "a", 1000, 500)).toBe(true);
    expect(tryAcquireLock(store, "k", "b", 1200, 500)).toBe(false);
    expect(tryAcquireLock(store, "k", "b", 1600, 500)).toBe(true);
    releaseLock(store, "k", "a");
    expect(store.getItem("k")).not.toBeNull();
    releaseLock(store, "k", "b");
    expect(store.getItem("k")).toBeNull();
  });
  test("corrupt lock counts as free", () => {
    const store = memoryStore();
    store.setItem("k", "{oops");
    expect(tryAcquireLock(store, "k", "a", 1)).toBe(true);
  });
  test("shouldImport only when imported is exactly false and idle", () => {
    expect(shouldImport(false, false)).toBe(true);
    expect(shouldImport(true, false)).toBe(false);
    expect(shouldImport(undefined, false)).toBe(false);
    expect(shouldImport(false, true)).toBe(false);
  });
});

describe("card resolution helpers", () => {
  test("missingSlugs skips cached and in-flight, dedupes", () => {
    const entries = [{ slug: "a", savedAt: 1 }, { slug: "b", savedAt: 1 }, { slug: "a", savedAt: 2 }, { slug: "c", savedAt: 1 }];
    const cache = { b: card("b") } as Record<string, MovieCard>;
    expect(missingSlugs(entries, cache, new Set(["c"]))).toEqual(["a"]);
  });
  test("chunk splits into batches of at most 60", () => {
    const parts = chunk(Array.from({ length: 130 }, (_, i) => String(i)));
    expect(parts.map((p) => p.length)).toEqual([60, 60, 10]);
  });
  test("parseCardsResponse drops malformed items", () => {
    expect(parseCardsResponse({ items: [{ slug: "a" }, null, { slug: 3 }, {}] }).map((c) => c.slug)).toEqual(["a"]);
    expect(parseCardsResponse(null)).toEqual([]);
  });
  test("parseCardsResponse maps raw API fields so posters and episode badge render", () => {
    const [c] = parseCardsResponse({
      items: [{ slug: "s", name: "S", thumb_url: "https://img/i/m/1.webp", poster_url: "https://img/i/d/2.webp", episode_current: "Tập 5" }],
    });
    expect(c.thumb).toBe("https://img/i/m/1.webp");
    expect(c.poster).toBe("https://img/i/d/2.webp");
    expect(c.episodeCurrent).toBe("Tập 5");
  });
  test("cards cached from the raw payload count as missing and are not resolved", () => {
    const raw = { slug: "r", name: "R", thumb_url: "x" } as unknown as MovieCard;
    expect(missingSlugs([{ slug: "r", savedAt: 1 }], { r: raw })).toEqual(["r"]);
    expect(resolveCards([{ slug: "r", savedAt: 1 }], { r: raw })).toEqual([]);
    expect(missingSlugs([{ slug: "a", savedAt: 1 }], { a: card("a") })).toEqual([]);
  });
});

describe("episode history", () => {
  const ep = { server: "Vietsub #1", key: "tap-5", name: "Tập 5" };
  test("old rows without ep still parse and stay ep-free", () => {
    expect(toSlugEntries([{ slug: "a", savedAt: 1 }])).toEqual([{ slug: "a", savedAt: 1 }]);
    expect(toEpisodeRef(undefined)).toBeUndefined();
    expect(toEpisodeRef({ server: 1, key: "k" })).toBeUndefined();
  });
  test("toEpisodeRef trims, caps at 100 and needs key+name", () => {
    expect(toEpisodeRef({ server: " S ", key: " k ", name: "n".repeat(150) })).toEqual({ server: "S", key: "k", name: "n".repeat(100) });
    expect(toEpisodeRef({ key: "k", name: "" })).toBeUndefined();
    expect(toEpisodeRef({ key: "k", name: "n" })).toEqual({ server: "", key: "k", name: "n" });
  });
  test("pushToHead keeps ep on a plain re-add and replaces it on a new ep", () => {
    const list = pushToHead([], "a", 1, 100, ep);
    expect(pushToHead(list, "a", 2)[0]).toEqual({ slug: "a", savedAt: 2, ep });
    const next = { server: "Vietsub #1", key: "tap-6", name: "Tập 6" };
    expect(pushToHead(list, "a", 3, 100, next)[0].ep).toEqual(next);
  });
  test("pushGuestHistory keeps stored ep without one and tolerates old rows", () => {
    const first = pushGuestHistory([{ ...card("old"), savedAt: 0 }], card("a"), 1, ep);
    expect(first.map((m) => m.slug)).toEqual(["a", "old"]);
    expect(first[0].ep).toEqual(ep);
    expect(pushGuestHistory(first, card("a"), 2)[0].ep).toEqual(ep);
    expect(pushGuestHistory(first, card("old"), 2)[0]).not.toHaveProperty("ep");
  });
  test("server rows map serverName/episodeKey/episodeName and null means no ep", () => {
    const out = parseServerItems({ items: [
      { slug: "a", at: 5, serverName: "S", episodeKey: "k", episodeName: "Tập 1" },
      { slug: "b", at: 4, serverName: null, episodeKey: null, episodeName: null },
    ] });
    expect(out[0]).toEqual({ slug: "a", savedAt: 5, ep: { server: "S", key: "k", name: "Tập 1" } });
    expect(out[1]).toEqual({ slug: "b", savedAt: 4 });
  });
  test("resolveCards carries ep", () => {
    const cache = upsertCard({}, card("a"));
    expect(resolveCards([{ slug: "a", savedAt: 3, ep }], cache)[0].ep).toEqual(ep);
  });
  test("import payload carries ep for history only", () => {
    const payload = buildImportPayload([{ slug: "a", savedAt: 1, ep }], [{ slug: "a", savedAt: 1, ep }, { slug: "b", savedAt: 0 }]);
    expect(payload.favorites).toEqual([{ slug: "a", savedAt: 1 }]);
    expect(payload.history[0]).toEqual({ slug: "a", savedAt: 1, ep: { serverName: "Vietsub #1", episodeKey: "tap-5", episodeName: "Tập 5" } });
    expect(payload.history[1]).toEqual({ slug: "b", savedAt: 0 });
  });
});
