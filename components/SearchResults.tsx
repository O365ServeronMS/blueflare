"use client";

import { useEffect, useState } from "react";
import { MovieCard } from "@/components/MovieCard";
import { Pagination } from "@/components/Pagination";
import { searchMovies } from "@/lib/catalog";
import { createReturnToPath, hrefWithPage, normalizePage } from "@/lib/navigation";
import type { ListPayload } from "@/lib/types";

type SearchState =
  | { status: "idle"; query: ""; page: 1 }
  | { status: "loading"; query: string; page: number }
  | { status: "ready"; query: string; page: number; data: ListPayload }
  | { status: "error"; query: string; page: number };

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const query = (params.get("q") || "").trim();
  return { query, page: normalizePage(params.get("page")) };
}

function pageHref(page: number) {
  return hrefWithPage(window.location.pathname, window.location.search, page);
}

export function SearchResults() {
  const [state, setState] = useState<SearchState>({ status: "idle", query: "", page: 1 });

  useEffect(() => {
    let active = true;
    const location = readLocation();
    if (!location.query) {
      setState({ status: "idle", query: "", page: 1 });
      document.title = "Tìm kiếm - Bluesia Cinema";
      return () => { active = false; };
    }

    setState({ status: "loading", ...location });
    searchMovies(location.query, location.page)
      .then((data) => {
        if (!active) return;
        const resolvedPage = data.totalPages ? Math.min(location.page, data.totalPages) : location.page;
        const normalizedHref = hrefWithPage(window.location.pathname, window.location.search, resolvedPage);
        if (normalizedHref !== `${window.location.pathname}${window.location.search}`) {
          window.history.replaceState({}, "", normalizedHref);
        }
        setState({ status: "ready", query: location.query, page: resolvedPage, data });
        document.title = `${data.title || "Tìm kiếm"} - Bluesia Cinema`;
      })
      .catch(() => {
        if (active) setState({ status: "error", ...location });
      });

    return () => { active = false; };
  }, []);

  const data = state.status === "ready" ? state.data : undefined;
  const returnTo = typeof window === "undefined" ? "/search" : createReturnToPath(window.location.pathname, window.location.search);

  if (state.status === "idle") {
    return (
      <section className="bf-page-gutter pb-20 pt-8">
        <p className="max-w-lg text-[15px] leading-6 text-silver">Nhập tên phim, tên gốc hoặc diễn viên. Nếu chưa có ý tưởng, bắt đầu từ những bộ sưu tập phổ biến.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <a href="/list/phim-moi-cap-nhat" className="rounded bg-graphite px-4 py-2.5 text-[13px] font-bold text-white hover:bg-charcoal">Mới cập nhật</a>
          <a href="/list/phim-le" className="rounded bg-graphite px-4 py-2.5 text-[13px] font-bold text-white hover:bg-charcoal">Phim lẻ</a>
          <a href="/list/phim-bo" className="rounded bg-graphite px-4 py-2.5 text-[13px] font-bold text-white hover:bg-charcoal">Phim bộ</a>
        </div>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="bf-page-gutter grid grid-cols-2 gap-x-3 gap-y-7 pb-20 pt-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-busy="true">
        {[...Array(14)].map((_, index) => <div key={index} className="aspect-[2/3] animate-pulse rounded bg-graphite" />)}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <section className="bf-page-gutter py-16">
        <h2 className="text-[26px] font-black text-white">Chưa tải được kết quả.</h2>
        <button type="button" onClick={() => window.location.reload()} className="mt-5 rounded bg-white px-4 py-2.5 text-[13px] font-bold text-black">Thử lại</button>
      </section>
    );
  }

  if (!data?.items.length) {
    return (
      <section className="bf-page-gutter py-14">
        <h2 className="text-[28px] font-black text-white">Không tìm thấy “{state.query}”.</h2>
        <p className="mt-3 text-[14px] text-silver">Thử tên ngắn hơn, tên gốc, hoặc tiếp tục khám phá thư viện.</p>
        <a href="/list/phim-moi-cap-nhat" className="mt-6 inline-flex rounded bg-graphite px-4 py-2.5 text-[13px] font-bold text-white">Xem phim mới</a>
      </section>
    );
  }

  return (
    <>
      <header className="bf-page-gutter pt-8">
        <p className="text-[12px] uppercase tracking-[0.12em] text-silver">Kết quả cho</p>
        <h1 className="mt-2 text-[28px] font-black text-white sm:text-[36px]">“{state.query}”</h1>
      </header>
      <section className="bf-page-gutter mt-7 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
        {data.items.map((movie) => <MovieCard key={movie.slug} movie={movie} returnTo={returnTo} />)}
      </section>
      <Pagination currentPage={state.page} totalPages={data.totalPages} buildUrl={pageHref} />
    </>
  );
}
