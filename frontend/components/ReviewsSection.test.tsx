import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewsSection } from "./ReviewsSection";
import { normalizeReviews, normalizeReviewsPage } from "@/lib/catalog";
import { formatReviewDate, isLongReview, reviewInitial } from "@/lib/reviews";

const base = { id: "1", author: "ngọc", rating: 8, content: "Phim hay", createdAt: "2026-03-05T10:00:00Z", url: "https://www.themoviedb.org/review/1", hasSpoiler: false };

describe("normalizeReviews", () => {
  test("maps fields and drops unusable rows", () => {
    const out = normalizeReviews([
      base,
      { id: "2", author: "", rating: null, content: "x", url: "javascript:alert(1)", hasSpoiler: true },
      { id: "3", content: "  " },
      { content: "no id" },
      { id: "4", content: "y", rating: 11 }
    ]);
    expect(out.map((r) => r.id)).toEqual(["1", "2", "4"]);
    expect(out[1]).toMatchObject({ author: "Ẩn danh", rating: null, url: null, hasSpoiler: true });
    expect(out[2].rating).toBeNull();
  });
  test("non-array is empty; page defaults", () => {
    expect(normalizeReviews(undefined)).toEqual([]);
    expect(normalizeReviewsPage({}).limit).toBe(10);
  });
});

describe("helpers", () => {
  test("initial, long, date", () => {
    expect(reviewInitial("ngọc")).toBe("N");
    expect(reviewInitial("")).toBe("?");
    expect(isLongReview("a".repeat(300))).toBe(true);
    expect(isLongReview("ngắn")).toBe(false);
    expect(formatReviewDate("bad")).toBe("");
    expect(formatReviewDate("2026-03-05T10:00:00Z")).toContain("2026");
  });
});

describe("ReviewsSection", () => {
  test("renders nothing without reviews", () => {
    expect(renderToStaticMarkup(<ReviewsSection slug="a" reviews={[]} reviewCount={0} />)).toBe("");
  });
  test("renders card, spoiler label, safe link, attribution and load-more", () => {
    const html = renderToStaticMarkup(
      <ReviewsSection slug="a" reviewCount={7} reviews={[{ ...base, hasSpoiler: true, content: "<b>x</b> " + "a".repeat(300) }]} />
    );
    expect(html).toContain("Spoiler");
    expect(html).toContain("★ 8/10");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Đọc tiếp");
    expect(html).toContain('rel="noopener nofollow noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Reviews by TMDB users");
    expect(html).toContain("Xem thêm đánh giá");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("blur");
  });
  test("no load-more when all loaded; no link when url null", () => {
    const html = renderToStaticMarkup(<ReviewsSection slug="a" reviewCount={1} reviews={[{ ...base, url: null, rating: null }]} />);
    expect(html).not.toContain("Xem thêm đánh giá");
    expect(html).not.toContain("Xem trên TMDB");
    expect(html).not.toContain("★");
  });
});

describe("review translation", () => {
  test("contentVi is trimmed and mapped; blank or non-string is dropped", () => {
    const out = normalizeReviews([
      { ...base, id: "a", contentVi: "  Phim hay  " },
      { ...base, id: "b", contentVi: "   " },
      { ...base, id: "c", contentVi: 5 },
      { ...base, id: "d", contentVi: null }
    ]);
    expect(out[0].contentVi).toBe("Phim hay");
    expect(out[1].contentVi).toBeUndefined();
    expect(out[2].contentVi).toBeUndefined();
    expect(out[3].contentVi).toBeUndefined();
  });
  test("shows translation by default with label, toggle and lang=vi", () => {
    const html = renderToStaticMarkup(
      <ReviewsSection slug="a" reviewCount={1} reviews={[{ ...base, content: "Great movie", contentVi: "Phim tuyệt vời" }]} />
    );
    expect(html).toContain("Phim tuyệt vời");
    expect(html).not.toContain("Great movie");
    expect(html).toContain("Đã dịch tự động");
    expect(html).toContain("Xem bản gốc");
    expect(html).toContain('lang="vi"');
    expect(html).not.toContain('lang="en"');
  });
  test("falls back to English without label or toggle", () => {
    const html = renderToStaticMarkup(
      <ReviewsSection slug="a" reviewCount={1} reviews={[{ ...base, content: "Great movie" }]} />
    );
    expect(html).toContain("Great movie");
    expect(html).toContain('lang="en"');
    expect(html).not.toContain("Đã dịch tự động");
    expect(html).not.toContain("Xem bản gốc");
    expect(html).not.toContain("Xem bản dịch");
  });
  test("escapes translated text and clamps on the shown text", () => {
    const html = renderToStaticMarkup(
      <ReviewsSection slug="a" reviewCount={1} reviews={[{ ...base, content: "short", contentVi: "<i>x</i> " + "a".repeat(300) }]} />
    );
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(html).not.toContain("<i>");
    expect(html).toContain("Đọc tiếp");
    expect(html).toContain("line-clamp-4");
  });
});
