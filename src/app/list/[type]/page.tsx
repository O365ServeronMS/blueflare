import type { Metadata } from "next";
import { connection } from "next/server";
import { MovieCard } from "@/components/MovieCard";
import { Pagination } from "@/components/Pagination";
import { getListServer } from "@/lib/catalog-server";
import { createReturnToPath, hrefWithPage, normalizePage } from "@/lib/navigation";

type Params = Promise<{ type: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const typeTitles: Record<string, string> = {
  "phim-moi-cap-nhat": "Mới cập nhật",
  "phim-le": "Phim lẻ",
  "phim-bo": "Phim bộ",
  "tv-shows": "TV Shows",
  "hoat-hinh": "Hoạt hình"
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function cleanFilter(value: string | string[] | undefined) {
  const slug = first(value).trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : "";
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { type } = await params;
  const title = typeTitles[type] || "Danh sách phim";
  return { title: `${title} — Blueflare`, description: `Khám phá ${title.toLowerCase()} trên Blueflare.` };
}

export default async function ListPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  await connection();
  const { type } = await params;
  const query = await searchParams;
  const page = normalizePage(first(query.page));
  const country = cleanFilter(query.country);
  const category = country ? "" : cleanFilter(query.category);
  const currentSearch = new URLSearchParams();
  if (country) currentSearch.set("country", country);
  if (category) currentSearch.set("category", category);
  if (page > 1) currentSearch.set("page", String(page));
  const data = await getListServer(type, page, { country, category });
  const returnTo = createReturnToPath(`/list/${type}`, currentSearch.toString()) || `/list/${type}`;
  // The heading names the catalog and nothing else. An active filter is a
  // separate, removable control — folding it into the h1 with a middle dot
  // turned the title into a breadcrumb, and printed the raw slug at that.
  const activeFilter = country || category;
  // Khi có bộ lọc, `data.title` là tên bộ lọc chứ không phải tên danh mục, nên
  // tiêu đề phải lấy từ typeTitles trước và chỉ rơi về data.title khi không lọc.
  const heading = typeTitles[type] || (activeFilter ? "Danh sách phim" : data.title);
  const activeFilterLabel = activeFilter ? (data.title || activeFilter) : "";
  const gridLabel = activeFilter ? `${heading}, lọc theo ${activeFilterLabel}` : heading;

  function listHref(nextPage: number, nextCountry = country, nextCategory = category) {
    const filters = new URLSearchParams();
    if (nextCountry) filters.set("country", nextCountry);
    else if (nextCategory) filters.set("category", nextCategory);
    const withPage = hrefWithPage(`/list/${type}`, filters.toString(), nextPage);
    return withPage;
  }

  return (
    <div className="bf-content-width pb-10 pt-24 md:pt-28">
      <header className="bf-page-gutter">
        <h1 className="text-[32px] font-black tracking-tight text-chalk-white sm:text-[44px]">{heading}</h1>
        {activeFilter ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="bf-tag bf-tag-outline" aria-current="true">{activeFilterLabel}</span>
            <a href={listHref(1, "", "")} className="text-[12px] font-bold text-chalk-white transition-colors hover:text-netflix-red">Xóa bộ lọc</a>
          </div>
        ) : null}
      </header>

      <section className="bf-page-gutter mt-7 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-label={gridLabel}>
        {data.items.map((movie) => <MovieCard key={movie.slug} movie={movie} headingLevel={2} navSourceKey={type} returnTo={returnTo} />)}
      </section>

      {!data.items.length ? <p className="bf-page-gutter mt-12 text-[15px] text-silver">Chưa có dữ liệu cho danh mục này.</p> : null}
      <Pagination currentPage={Math.min(data.page || page, data.totalPages || page)} totalPages={data.totalPages} buildUrl={(nextPage) => listHref(nextPage)} />
    </div>
  );
}
