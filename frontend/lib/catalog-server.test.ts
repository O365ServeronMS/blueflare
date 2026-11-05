import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheLife = vi.fn();
const cacheTag = vi.fn();
vi.mock("next/cache", () => ({ cacheLife, cacheTag }));

const { CatalogHttpError, getListServer, getMovieServer, getPersonServer } = await import("@/lib/catalog-server");

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  cacheLife.mockClear();
  cacheTag.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("getMovieServer", () => {
  it("returns data and the 900s profile on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { movie: { name: "A", slug: "a" }, episodes: [] })));
    const movie = await getMovieServer("a");
    expect(movie?.slug).toBe("a");
    expect(cacheLife).toHaveBeenCalledWith({ stale: 900, revalidate: 900, expire: 86400 });
    expect(cacheTag).toHaveBeenCalledWith("movie:a");
  });

  it("returns null with a short profile on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404)));
    expect(await getMovieServer("x")).toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith({ stale: 60, revalidate: 60, expire: 300 });
  });

  it("throws CatalogHttpError on 500 without cacheLife", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await expect(getMovieServer("x")).rejects.toMatchObject({ name: "CatalogHttpError", status: 500 });
    await expect(getMovieServer("x")).rejects.toBeInstanceOf(CatalogHttpError);
    expect(cacheLife).not.toHaveBeenCalled();
  });

  it("rejects on a network error without cacheLife", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(getMovieServer("x")).rejects.toThrow("fetch failed");
    expect(cacheLife).not.toHaveBeenCalled();
  });
});

describe("getPersonServer", () => {
  it("returns data and the long profile on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { data: { items: [], person: { name: "P", slug: "p" } } })));
    const person = await getPersonServer("p");
    expect(person?.person.name).toBe("P");
    expect(cacheLife).toHaveBeenCalledWith({ stale: 900, revalidate: 3600, expire: 86400 });
  });

  it("returns null with a short profile on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404)));
    expect(await getPersonServer("x")).toBeNull();
    expect(cacheLife).toHaveBeenCalledWith({ stale: 60, revalidate: 60, expire: 300 });
  });

  it("throws CatalogHttpError on 500 without cacheLife", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await expect(getPersonServer("x")).rejects.toMatchObject({ name: "CatalogHttpError", status: 500 });
    expect(cacheLife).not.toHaveBeenCalled();
  });

  it("rejects on a network error without cacheLife", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(getPersonServer("x")).rejects.toThrow("fetch failed");
    expect(cacheLife).not.toHaveBeenCalled();
  });
});

describe("getListServer", () => {
  it("throws CatalogHttpError on 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(503)));
    const err = await getListServer("phim-le").catch((e) => e);
    expect(err).toBeInstanceOf(CatalogHttpError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/^Catalog API 503: /);
  });
});
