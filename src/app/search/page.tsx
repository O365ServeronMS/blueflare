import type { Metadata } from "next";
import { connection } from "next/server";
import { MovieCard } from "@/components/MovieCard";
import { Pagination } from "@/components/Pagination";
import { searchServer } from "@/lib/catalog-server";
import { createReturnToPath, hrefWithPage, normalizePage } from "@/lib/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const query = await searchParams;
  const keyword = first(query.q).trim();
  return { title: keyword ? `Tìm kiếm: ${keyword} — Blueflare` : "Tìm kiếm — Blueflare" };
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const query = await searchParams;
  const keyword = first(query.q).trim();
  const page = normalizePage(first(query.page));
  const data = await searchServer(keyword, page);
  const currentSearch = new URLSearchParams();
  if (keyword) currentSearch.set("q", keyword);
  if (page > 1) currentSearch.set("page", String(page));
  const returnTo = createReturnToPath("/search", currentSearch.toString()) || "/search";

  function pageHref(nextPage: number) {
    const search = new URLSearchParams();
    if (keyword) search.set("q", keyword);
    return hrefWithPage("/search", search.toString(), nextPage);
  }

  return (
    <div className="bf-content-width pb-10 pt-24 md:pt-28">
      <header className="bf-page-gutter">
        <h1 className="text-[32px] font-black tracking-tight text-chalk-white sm:text-[44px]">{keyword ? `Kết quả cho “${keyword}”` : "Tìm kiếm phim"}</h1>
      </header>
      {keyword ? (
        <section className="bf-page-gutter mt-7 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-label="Kết quả tìm kiếm">
          {data.items.map((movie) => <MovieCard key={movie.slug} movie={movie} headingLevel={2} returnTo={returnTo} />)}
        </section>
      ) : <p className="bf-page-gutter mt-8 text-[15px] text-silver">Nhập tên phim để bắt đầu tìm kiếm.</p>}
      {keyword && !data.items.length ? <p className="bf-page-gutter mt-12 text-[15px] text-silver">Không tìm thấy kết quả phù hợp.</p> : null}
      <Pagination currentPage={data.page || page} totalPages={data.totalPages} buildUrl={pageHref} />
    </div>
  );
}
