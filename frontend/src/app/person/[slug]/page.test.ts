import { beforeEach, describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const getPersonServer = vi.fn();

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/catalog-server", () => ({
  getPersonServer,
  CatalogHttpError: class CatalogHttpError extends Error {
    constructor(readonly status: number, readonly path: string) {
      super(`Catalog API ${status}: ${path}`);
    }
  }
}));
// Rendering children is out of scope: the page is only called up to its guard.
vi.mock("@/components/CastStrip", () => ({ CastStrip: () => null }));
vi.mock("@/components/ExpandableSynopsis", () => ({ ExpandableSynopsis: () => null }));
vi.mock("@/components/LocalMovieActions", () => ({ MovieActions: () => null }));
vi.mock("@/components/MoviePlayer", () => ({ MoviePlayer: () => null }));
vi.mock("@/components/LastWatchedBadge", () => ({ LastWatchedBadge: () => null }));
vi.mock("@/components/ReviewsSection", () => ({ ReviewsSection: () => null }));
vi.mock("@/components/RecommendationRail", () => ({ RecommendationRail: () => null }));
vi.mock("@/components/ScoreBadges", () => ({ ScoreBadges: () => null }));
vi.mock("@/components/MovieCard", () => ({ MovieCard: () => null }));
vi.mock("@/components/Pagination", () => ({ Pagination: () => null }));

const { CatalogHttpError } = await import("@/lib/catalog-server");
const page = await import("./page");
const Page = page.default;
const props = { params: Promise.resolve({ slug: "s" }), searchParams: Promise.resolve({}) };

beforeEach(() => {
  notFound.mockClear();
  getPersonServer.mockReset();
});

describe("person page", () => {
  it("calls notFound when the API answered 404 (null)", async () => {
    getPersonServer.mockResolvedValue(null);
    await expect(Page(props)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("lets a CatalogHttpError(500) reach error.tsx", async () => {
    const error = new CatalogHttpError(500, "/api/x");
    getPersonServer.mockRejectedValue(error);
    await expect(Page(props)).rejects.toBe(error);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("generateMetadata keeps the not-found title for null", async () => {
    getPersonServer.mockResolvedValue(null);
    const meta = await page.generateMetadata({ params: props.params });
    expect(String(meta.title)).toContain("Không tìm thấy");
  });

  it("generateMetadata on 500 has no not-found title", async () => {
    getPersonServer.mockRejectedValue(new CatalogHttpError(500, "/api/x"));
    const meta = await page.generateMetadata({ params: props.params });
    expect(String(meta.title)).not.toContain("Không tìm thấy");
  });

  it("generateMetadata uses the name when found", async () => {
    getPersonServer.mockResolvedValue({ person: { name: "Ten A" } });
    const meta = await page.generateMetadata({ params: props.params });
    expect(String(meta.title)).toMatch(/A — Blueflare/);
  });
});
