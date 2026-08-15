import { cacheLife, cacheTag } from "next/cache";
import { normalizedEpisodeName, normalizedEpisodeSlug } from "@/lib/episodes";
import { normalizeCard } from "@/lib/catalog";
import { normalizePage } from "@/lib/navigation";
import type { EpisodeServer, HomePayload, ListPayload, MovieDetail } from "@/lib/types";

const INTERNAL_CATALOG_BASE = (process.env.INTERNAL_CATALOG_URL || process.env.CATALOG_BASE_URL || "https://img.bluesia.net").replace(/\/$/, "");

async function fetchCatalog<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${INTERNAL_CATALOG_BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers || {}) }
  });
  if (!response.ok) throw new Error(`Catalog API ${response.status}: ${path}`);
  return response.json() as Promise<T>;
}

function listData(payload: any) {
  const data = payload?.data || payload;
  const items = data?.items || data?.movies || payload?.items || [];
  const pagination = data?.params?.pagination || data?.pagination || payload?.pagination || {};
  return { items: Array.isArray(items) ? items : [], pagination, data };
}

function toListPayload(payload: any, fallbackTitle: string, page: number): ListPayload {
  const { items, pagination, data } = listData(payload);
  const totalItems = Number(pagination?.totalItems || 0);
  const perPage = Number(pagination?.totalItemsPerPage || 24);
  const computedTotalPages = totalItems > 0 && perPage > 0 ? Math.ceil(totalItems / perPage) : 0;
  return {
    title: data?.titlePage || fallbackTitle,
    items: items.map(normalizeCard).filter((movie) => movie.slug),
    page: Number(pagination?.currentPage || page),
    totalPages: Number(pagination?.totalPages || pagination?.total_pages || computedTotalPages) || undefined
  };
}

function labelText(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map((label) => label?.name).filter(Boolean).join(", ") || undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function detailLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((label) => label && label.name && label.slug)
    .map((label) => ({ id: label.id || label._id || undefined, name: label.name, slug: label.slug }));
}

export async function getHomeServer(): Promise<HomePayload> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 300, expire: 86400 });
  cacheTag("home");
  const data = await fetchCatalog<any>("/api/home-data");
  const section = (raw: any, title: string, href: string) => ({
    title,
    href,
    items: (Array.isArray(raw?.items) ? raw.items : []).map(normalizeCard)
  });
  return {
    hero: (Array.isArray(data?.heroMovies) ? data.heroMovies : []).map(normalizeCard),
    sections: [
      section(data?.newMovies, "Phim mới cập nhật", "/list/phim-moi-cap-nhat"),
      section(data?.phimLe, "Phim lẻ", "/list/phim-le"),
      section(data?.phimBo, "Phim bộ", "/list/phim-bo"),
      section(data?.hoatHinh, "Hoạt hình", "/list/hoat-hinh")
    ].filter((entry) => entry.items.length)
  };
}

export async function getListServer(type: string, page = 1, filters?: { country?: string; category?: string }): Promise<ListPayload> {
  "use cache";
  const safePage = normalizePage(page);
  const country = String(filters?.country || "").trim().toLowerCase();
  const category = String(filters?.category || "").trim().toLowerCase();
  cacheLife({ stale: 300, revalidate: 300, expire: 86400 });
  const tags = ["list", `list:${type}`, `page:${safePage}`];
  if (country) tags.push(`country:${country}`);
  if (category) tags.push(`category:${category}`);
  cacheTag(...tags);
  const params = new URLSearchParams({ type, page: String(safePage) });
  const path = country
    ? `/api/country?slug=${encodeURIComponent(country)}&page=${safePage}`
    : category
      ? `/api/genre?slug=${encodeURIComponent(category)}&page=${safePage}`
      : `/api/list?${params.toString()}`;
  return toListPayload(await fetchCatalog(path), "Danh sách phim", safePage);
}

export async function searchServer(keyword: string, page = 1): Promise<ListPayload> {
  const query = String(keyword || "").trim();
  const safePage = normalizePage(page);
  if (!query) return { title: "Tìm kiếm", items: [], page: safePage };
  return toListPayload(
    await fetchCatalog(`/api/search?keyword=${encodeURIComponent(query)}&page=${safePage}`, { cache: "no-store" }),
    `Tìm kiếm: ${query}`,
    safePage
  );
}

export async function getMovieServer(slug: string): Promise<MovieDetail> {
  "use cache";
  const safeSlug = String(slug || "").trim();
  cacheLife({ stale: 900, revalidate: 900, expire: 86400 });
  cacheTag(`movie:${safeSlug}`);
  const payload = await fetchCatalog<any>(`/api/movie/${encodeURIComponent(safeSlug)}`);
  const movieRaw = payload?.movie || payload?.data?.item || payload?.data?.movie || {};
  const episodesRaw = payload?.episodes || movieRaw?.episodes || payload?.data?.episodes || [];
  const episodes: EpisodeServer[] = (Array.isArray(episodesRaw) ? episodesRaw : [])
    .map((server: any) => ({
      serverName: server?.server_name || server?.serverName || "Server",
      serverData: (server?.server_data || server?.serverData || []).map((episode: any, index: number) => ({
        name: normalizedEpisodeName(episode, index),
        slug: normalizedEpisodeSlug(episode, index),
        filename: episode?.filename || undefined,
        linkEmbed: episode?.link_embed || episode?.linkEmbed || undefined,
        linkM3u8: episode?.link_m3u8 || episode?.linkM3u8 || undefined
      }))
    }))
    .filter((server: EpisodeServer) => server.serverData.length);
  return {
    ...normalizeCard(movieRaw),
    content: movieRaw?.content || movieRaw?.description || undefined,
    actor: Array.isArray(movieRaw?.actor) ? movieRaw.actor.filter(Boolean) : [],
    director: Array.isArray(movieRaw?.director) ? movieRaw.director.filter(Boolean) : [],
    episodeTotal: movieRaw?.episode_total || movieRaw?.episodeTotal || undefined,
    categoryList: detailLabels(movieRaw?.category),
    countryList: detailLabels(movieRaw?.country),
    episodes
  };
}
