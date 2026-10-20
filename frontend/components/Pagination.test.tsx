import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Pagination } from "./Pagination";
import { hrefWithPage } from "@/lib/navigation";

// Reads the rendered window back as "1 ... 13 14 [15] 16 17 ... 777": the brackets mark the current page.
function windowOf(currentPage: number, totalPages: number) {
  const html = renderToStaticMarkup(
    <Pagination currentPage={currentPage} totalPages={totalPages} buildUrl={(page) => "/list/phim-le?page=" + page} />
  );
  const items = [...html.matchAll(/<(a|span)([^>]*)>([\s\S]*?)<\/\1>/g)]
    .filter(([, , attrs]) => /aria-label="Trang|aria-hidden="true"/.test(attrs) && !/<svg/.test(attrs))
    .map(([, tag, attrs, body]) => {
      if (/aria-hidden="true"/.test(attrs)) return "...";
      return /aria-current="page"/.test(attrs) ? "[" + body + "]" : body;
    });
  return items.join(" ");
}

describe("Pagination window (frontend/PAGINATION.md examples)", () => {
  test("middle page", () => {
    expect(windowOf(15, 777)).toBe("1 ... 13 14 [15] 16 17 ... 777");
  });
  test("near the start", () => {
    expect(windowOf(3, 777)).toBe("1 2 [3] 4 5 ... 777");
  });
  test("near the end", () => {
    expect(windowOf(776, 777)).toBe("1 ... 774 775 [776] 777");
  });
  test("a gap of exactly 2 inserts the missing page instead of an ellipsis", () => {
    expect(windowOf(5, 777)).toBe("1 2 3 4 [5] 6 7 ... 777");
    expect(windowOf(773, 777)).toBe("1 ... 771 772 [773] 774 775 776 777");
  });
  test("first and last page, no duplicates or out-of-range pages", () => {
    expect(windowOf(1, 777)).toBe("[1] 2 3 ... 777");
    expect(windowOf(777, 777)).toBe("1 ... 775 776 [777]");
    expect(windowOf(2, 3)).toBe("1 [2] 3");
  });
  test("one page or none renders nothing", () => {
    expect(renderToStaticMarkup(<Pagination currentPage={1} totalPages={1} buildUrl={String} />)).toBe("");
    expect(renderToStaticMarkup(<Pagination currentPage={1} buildUrl={String} />)).toBe("");
  });
});

describe("Pagination links", () => {
  test("the current page and the ellipsis are not links; other pages use buildUrl", () => {
    const html = renderToStaticMarkup(
      <Pagination currentPage={15} totalPages={777} buildUrl={(page) => hrefWithPage("/search", "?q=batman&type=phim-le", page)} />
    );
    expect(html).not.toMatch(/<a[^>]*aria-label="Trang 15"/);
    expect(html).toMatch(/<span[^>]*aria-current="page"[^>]*>15<\/span>/);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href.replace(/&amp;/g, "&"));
    expect(hrefs).toHaveLength(6);
    for (const href of hrefs) {
      const params = new URL(href, "https://phim.bluesia.net").searchParams;
      expect(params.get("q")).toBe("batman");
      expect(params.get("type")).toBe("phim-le");
    }
  });
});
