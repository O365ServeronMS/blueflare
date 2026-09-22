import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft } from "lucide-react";
import { MovieCard } from "@/components/MovieCard";
import { Pagination } from "@/components/Pagination";
import { getPersonServer } from "@/lib/catalog-server";
import { createReturnToPath, getBackHref, hrefWithPage, normalizePage, returnToFromSearchParams } from "@/lib/navigation";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function cleanRole(value: string | string[] | undefined) {
  const role = first(value);
  return role === "cast" || role === "director" ? role : "all";
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  try {
    const { slug } = await params;
    const data = await getPersonServer(slug);
    return { title: `${data.person.name} — Blueflare` };
  } catch {
    return { title: "Không tìm thấy — Blueflare" };
  }
}

export default async function PersonPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  await connection();
  const { slug } = await params;
  const query = await searchParams;
  const page = normalizePage(first(query.page));
  const role = cleanRole(query.role);

  let data;
  try {
    data = await getPersonServer(slug, page, role);
  } catch {
    notFound();
  }

  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) urlParams.set(key, first(value));
  }
  // Where this page was opened from. Kept across pagination so paging through a
  // filmography does not strand the visitor with no way back to the list.
  const inboundReturnTo = returnToFromSearchParams(urlParams);
  const backHref = getBackHref(urlParams, { fallbackPath: "/" });

  const currentSearch = new URLSearchParams();
  if (role !== "all") currentSearch.set("role", role);
  if (page > 1) currentSearch.set("page", String(page));
  const returnTo = createReturnToPath(`/person/${slug}`, currentSearch.toString()) || `/person/${slug}`;

  function personHref(nextPage: number) {
    const filters = new URLSearchParams();
    if (role !== "all") filters.set("role", role);
    if (inboundReturnTo) filters.set("returnTo", inboundReturnTo);
    return hrefWithPage(`/person/${slug}`, filters.toString(), nextPage);
  }

  return (
    <div className="bf-content-width pb-10 pt-24 md:pt-28">
      <div className="bf-page-gutter mb-5">
        <a
          href={backHref}
          data-nav-back
          aria-label="Quay lại"
          className="grid h-11 w-11 place-items-center rounded bg-graphite text-white transition hover:bg-charcoal"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
      </div>

      <header className="bf-page-gutter flex items-center gap-5">
        {data.person.photo ? (
          <img
            src={data.person.photo}
            alt=""
            width={96}
            height={144}
            className="aspect-[2/3] w-24 shrink-0 rounded object-cover"
          />
        ) : null}
        <div>
          <h1 className="text-[32px] font-black tracking-tight text-chalk-white sm:text-[44px]">{data.person.name}</h1>
          {data.totalItems ? <p className="mt-2 text-body text-silver">{data.totalItems} phim</p> : null}
        </div>
      </header>

      <section
        className="bf-page-gutter mt-7 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7"
        aria-label={`Phim của ${data.person.name}`}
      >
        {data.items.map((movie) => <MovieCard key={movie.slug} movie={movie} headingLevel={2} returnTo={returnTo} />)}
      </section>

      {!data.items.length ? (
        <p className="bf-page-gutter mt-12 text-body text-silver">Chưa có phim nào của người này trên Blueflare.</p>
      ) : null}
      <Pagination currentPage={Math.min(data.page || page, data.totalPages || page)} totalPages={data.totalPages} buildUrl={(nextPage) => personHref(nextPage)} />
    </div>
  );
}
