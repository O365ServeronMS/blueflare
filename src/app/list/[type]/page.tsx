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
  return { title: `${title} — Bluesia Cinema`, description: `Khám phá ${title.toLowerCase()} trên Bluesia Cinema.` };
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
  const title = [typeTitles[type] || data.title, country, category].filter(Boolean).join(" · ");

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
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Khám phá Blueflare</p>
        <h1 className="mt-2 text-[32px] font-black tracking-tight text-chalk-white sm:text-[44px]">{title}</h1>
      </header>

      <section className="bf-page-gutter mt-7 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-label={title}>
        {data.items.map((movie) => <MovieCard key={movie.slug} movie={movie} headingLevel={2} navSourceKey={type} returnTo={returnTo} />)}
      </section>

      {!data.items.length ? <p className="bf-page-gutter mt-12 text-[15px] text-silver">Chưa có dữ liệu cho danh mục này.</p> : null}
      <Pagination currentPage={Math.min(data.page || page, data.totalPages || page)} totalPages={data.totalPages} buildUrl={(nextPage) => listHref(nextPage)} />
    </div>
  );
}
