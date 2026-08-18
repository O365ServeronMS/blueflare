import { useEffect, useState } from "react";
import { MovieCard } from "./MovieCard";
import { Pagination } from "./Pagination";
import { getCategories, getCountries, getCountry, getGenre, getList } from "@/lib/catalog";
import type { ListPayload, SourceLabel } from "@/lib/types";
import { createReturnToPath, hrefWithPage, normalizePage } from "@/lib/navigation";

const quickCountries = [
  { label: "Âu Mỹ", slug: "au-my" },
  { label: "Hàn Quốc", slug: "han-quoc" }
];
const quickCategories = [{ label: "Phim chiếu rạp", slug: "phim-chieu-rap" }];
const countryFilterableTypes = new Set(["phim-le", "phim-bo", "tv-shows"]);
const categoryFilterableTypes = new Set(["phim-le"]);

function safeFilterSlug(value: string | null | undefined) {
  const slug = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : "";
}

export function ListIsland({ type, returnTo: initialReturnTo = "" }: { type: string; returnTo?: string }) {
  const [data, setData] = useState<ListPayload | null>(null);
  const [countries, setCountries] = useState<SourceLabel[]>([]);
  const [categories, setCategories] = useState<SourceLabel[]>([]);
  const [visibleItems, setVisibleItems] = useState(18);
  const [error, setError] = useState(false);

  const pathname = typeof window !== "undefined" ? window.location.pathname : `/list/${type}`;
  const search = typeof window !== "undefined" ? window.location.search : "";
  const searchParams = new URLSearchParams(search);
  const page = normalizePage(searchParams.get("page"));
  const requestedCountry = safeFilterSlug(searchParams.get("country"));
  const requestedCategory = requestedCountry ? "" : safeFilterSlug(searchParams.get("category"));
  const supportsCountryFilter = countryFilterableTypes.has(type);
  const supportsCategoryFilter = categoryFilterableTypes.has(type);
  const returnSearchParams = new URLSearchParams(search);
  if (page === 1) returnSearchParams.delete("page");
  else returnSearchParams.set("page", String(page));
  if (requestedCountry) returnSearchParams.delete("category");
  const returnTo = createReturnToPath(pathname, returnSearchParams.toString()) || initialReturnTo || `/list/${type}`;

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const listPromise = requestedCountry
          ? getCountry(requestedCountry, page)
          : requestedCategory
            ? getGenre(requestedCategory, page)
            : getList(type, page);
        const tasks: Promise<void>[] = [
          listPromise.then((payload) => { if (active) setData(payload); })
        ];
        if (supportsCountryFilter) tasks.push(getCountries().then((items) => { if (active) setCountries(items); }).catch(() => {}));
        if (supportsCategoryFilter) tasks.push(getCategories().then((items) => { if (active) setCategories(items); }).catch(() => {}));
        await Promise.all(tasks);
      } catch (err) {
        console.error("[ListIsland] Failed to load", err);
        if (active) setError(true);
      }
    }

    loadData();
    return () => { active = false; };
  }, [type, page, requestedCountry, requestedCategory, supportsCategoryFilter, supportsCountryFilter]);

  useEffect(() => {
    setVisibleItems(18);
  }, [page, requestedCountry, requestedCategory]);

  useEffect(() => {
    if (!data || visibleItems >= data.items.length) return;
    const timer = window.setTimeout(() => setVisibleItems((previous) => previous + 18), 100);
    return () => window.clearTimeout(timer);
  }, [data, visibleItems]);

  useEffect(() => {
    if (!data || typeof window === "undefined") return;
    const resolvedPage = data.totalPages ? Math.min(page, data.totalPages) : page;
    const normalizedHref = hrefWithPage(window.location.pathname, window.location.search, resolvedPage);
    const normalizedUrl = new URL(normalizedHref, window.location.origin);
    if (requestedCountry) normalizedUrl.searchParams.delete("category");
    const canonicalHref = `${normalizedUrl.pathname}${normalizedUrl.search}`;
    if (canonicalHref !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState({}, "", canonicalHref);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [data, page]);

  if (error) {
    return (
      <section className="bf-content-width bf-page-gutter flex min-h-[70vh] items-center pt-20">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-netflix-red">Không thể tải danh mục</p>
          <h1 className="mt-3 text-[34px] font-black text-chalk-white">Thư viện đang gián đoạn.</h1>
          <button type="button" onClick={() => window.location.reload()} className="mt-6 min-h-11 rounded bg-chalk-white px-5 text-[14px] font-bold text-deep-space">Thử lại</button>
        </div>
      </section>
    );
  }

  const country = supportsCountryFilter ? requestedCountry : "";
  const category = supportsCategoryFilter && !country ? requestedCategory : "";
  const activeFilters = { country, category };

  const typeTitles: Record<string, string> = {
    "phim-moi-cap-nhat": "Mới cập nhật",
    "phim-le": "Phim lẻ",
    "phim-bo": "Phim bộ",
    "tv-shows": "TV Shows",
    "hoat-hinh": "Hoạt hình"
  };

  function listHref(nextPage: number, filters = activeFilters) {
    const href = hrefWithPage(`/list/${type}`, search, nextPage);
    const url = new URL(href, window.location.origin);
    url.searchParams.delete("country");
    url.searchParams.delete("category");
    if (filters.country) url.searchParams.set("country", filters.country);
    else if (filters.category) url.searchParams.set("category", filters.category);
    return `${url.pathname}${url.search}`;
  }

  if (!data) {
    return (
      <div className="bf-content-width bf-page-gutter pb-16 pt-28" aria-busy="true">
        <div className="h-9 w-56 animate-pulse rounded bg-graphite" />
        <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
          {[...Array(18)].map((_, index) => <div key={index} className="aspect-[2/3] animate-pulse rounded bg-graphite" />)}
        </div>
      </div>
    );
  }

  const activeCountryName = countries.find((item) => item.slug === country)?.name || quickCountries.find((item) => item.slug === country)?.label;
  const activeCategoryName = categories.find((item) => item.slug === category)?.name || quickCategories.find((item) => item.slug === category)?.label;
  const displayTitle = [typeTitles[type] || data.title, activeCountryName, activeCategoryName].filter(Boolean).join(" · ");

  return (
    <div className="bf-content-width pb-10 pt-24 md:pt-28">
      <header className="bf-page-gutter">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Khám phá Blueflare</p>
        <h1 className="mt-2 text-[32px] font-black tracking-tight text-chalk-white sm:text-[44px]">{displayTitle}</h1>
      </header>

      {(supportsCountryFilter || supportsCategoryFilter) ? (
        <section className="bf-page-gutter mt-5" aria-label="Lọc nhanh">
          <div className="no-scrollbar flex gap-2 overflow-x-auto pb-2">
            <a href={listHref(1, { country: "", category: "" })} aria-current={!country && !category ? "true" : undefined} className="bf-tag bf-tag-outline whitespace-nowrap">Tất cả</a>
            {supportsCountryFilter ? quickCountries.map((item) => (
              <a key={item.slug} href={listHref(1, { country: item.slug, category: "" })} aria-current={country === item.slug ? "true" : undefined} className="bf-tag bf-tag-outline whitespace-nowrap">{item.label}</a>
            )) : null}
            {supportsCategoryFilter ? quickCategories.map((item) => (
              <a key={item.slug} href={listHref(1, { country: "", category: item.slug })} aria-current={category === item.slug ? "true" : undefined} className="bf-tag bf-tag-outline whitespace-nowrap">{item.label}</a>
            )) : null}
          </div>
        </section>
      ) : null}

      <section className="bf-page-gutter mt-7 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-label={displayTitle}>
        {data.items.slice(0, visibleItems).map((movie) => (
          <MovieCard key={movie.slug} movie={movie} headingLevel={2} navSourceKey={type} returnTo={returnTo} />
        ))}
      </section>

      {visibleItems >= data.items.length ? (
        <Pagination currentPage={Math.min(data.page || page, data.totalPages || page)} totalPages={data.totalPages} buildUrl={(nextPage) => listHref(nextPage)} />
      ) : null}

      {visibleItems >= data.items.length && (countries.length || categories.length) ? (
        <section className="bf-page-gutter mt-10 border-t border-white/10 pt-7" aria-labelledby="catalog-tags">
          <div className="flex items-center justify-between gap-3">
            <h2 id="catalog-tags" className="text-[12px] font-bold uppercase tracking-[0.12em] text-silver">Khám phá theo thẻ</h2>
            {(country || category) ? <a href={listHref(1, { country: "", category: "" })} className="text-[12px] font-bold text-chalk-white hover:text-netflix-red">Xóa bộ lọc</a> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-3">
            {[...countries, ...categories].map((item, index) => item.slug && item.name ? (
              <a key={`${item.slug}-${index}`} href={countries.includes(item) ? listHref(1, { country: item.slug, category: "" }) : listHref(1, { country: "", category: item.slug })} className="text-[13px] text-ash transition hover:text-chalk-white">{item.name}</a>
            ) : null)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
