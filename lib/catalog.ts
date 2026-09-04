/**
 * Catalog API client (browser-safe).
 *
 * All catalog data and pre-signed images are served by the VPS Blueflare Docker
 * API at `img.bluesia.net/api/*`. This module fetches those payloads client-side
 * and maps them to the app's `MovieCard`/`MovieDetail` shapes.
 *
 * The frontend does NO image signing and NO direct provider metadata calls:
 * `thumb_url` (pre-signed `/i/m/…` portrait) and `poster_url` (pre-signed
 * `/i/d/…` landscape) arrive ready to render. The shared image cache is keyed
 * only by `sha256(upstreamUrl)+variant`, so phim.bluesia.net and film.bluesia.net
 * reuse the exact same `/m` and `/d` objects.
 */
import type { EpisodeServer, HomePayload, ListPayload, MovieCard, MovieDetail } from "@/lib/types";
import { normalizedEpisodeName, normalizedEpisodeSlug } from "@/lib/episodes";
import { normalizePage } from "@/lib/navigation";

export const CATALOG_BASE = "https://img.bluesia.net";
type RawItem = Record<string, any>;

const cache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 5 * 60 * 1000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const noStore = init?.cache === "no-store";
  if (!noStore) {
    const entry = cache.get(url);
    if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data as T;
  }
  const res = await fetch(url, { headers: { Accept: "application/json" }, ...init });
  if (!res.ok) throw new Error(`Catalog API ${res.status}: ${url}`);
  const data = (await res.json()) as T;
  if (!noStore) cache.set(url, { data, time: Date.now() });
  return data;
}

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function labelText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map((label) => label?.name).filter(Boolean).join(", ") || undefined;
  }
  return typeof value === "string" && value.trim() ? value : undefined;
}

function detailLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((label) => label && label.name && label.slug)
    .map((label) => ({ id: label.id || label._id || undefined, name: label.name, slug: label.slug }));
}

/** Map a canonical catalog-api item with pre-signed images to a MovieCard. */
export function normalizeCard(raw: RawItem): MovieCard {
  const tmdbRating = num(raw?.vote_average) ?? num(raw?.tmdb?.vote_average);
  const imdbRating = num(raw?.imdb?.vote_average) ?? num(raw?.imdb?.rating);
  return {
    name: raw?.name || raw?.origin_name || "Không rõ tên",
    originName: raw?.origin_name || undefined,
    slug: raw?.slug || raw?._id || "",
    // Pre-signed: thumb_url = portrait (/i/m/), poster_url = landscape (/i/d/).
    thumb: raw?.thumb_url || raw?.poster_url || "",
    poster: raw?.poster_url || raw?.thumb_url || "",
    year: raw?.year || undefined,
    quality: raw?.quality || undefined,
    lang: raw?.lang || undefined,
    type: raw?.type || undefined,
    status: raw?.status || undefined,
    episodeCurrent: raw?.episode_current || undefined,
    time: raw?.time || undefined,
    imdbRating,
    tmdbRating,
    tmdb: {
      id: raw?.tmdb?.id ?? undefined,
      type: raw?.tmdb?.type || undefined,
      vote_average: tmdbRating,
      vote_count: num(raw?.tmdb?.vote_count)
    },
    imdb: {
      id: raw?.imdb?.id ? String(raw.imdb.id) : undefined,
      rating: imdbRating,
      vote_count: num(raw?.imdb?.vote_count)
    },
    tomatometer: num(raw?.rotten?.tomatometer),
    country: labelText(raw?.country),
    category: labelText(raw?.category),
    content: typeof raw?.content === "string" && raw.content.trim() ? raw.content : undefined
  };
}

function listData(payload: any) {
  const data = payload?.data || payload;
  const items = data?.items || data?.movies || payload?.items || [];
  const pagination = data?.params?.pagination || data?.pagination || payload?.pagination || {};
  return { items: Array.isArray(items) ? items : [], pagination, data };
}

function listPayload(payload: any, fallbackTitle: string, page: number): ListPayload {
  const { items, pagination, data } = listData(payload);
  const totalItems = Number(pagination?.totalItems || 0);
  const perPage = Number(pagination?.totalItemsPerPage || 24);
  const computedTotalPages = totalItems > 0 && perPage > 0 ? Math.ceil(totalItems / perPage) : 0;
  return {
    title: data?.titlePage || fallbackTitle,
    items: items.map(normalizeCard).filter((movie: MovieCard) => movie.slug),
    page: Number(pagination?.currentPage || page),
    totalPages: Number(pagination?.totalPages || pagination?.total_pages || computedTotalPages) || undefined
  };
}

export async function getList(type: string, page = 1): Promise<ListPayload> {
  const safePage = normalizePage(page);
  const payload = await fetchJson(`${CATALOG_BASE}/api/list?type=${encodeURIComponent(type)}&page=${safePage}`);
  return listPayload(payload, "Danh sách phim", safePage);
}

export async function getGenre(slug: string, page = 1): Promise<ListPayload> {
  const safePage = normalizePage(page);
  const payload = await fetchJson(`${CATALOG_BASE}/api/genre?slug=${encodeURIComponent(slug)}&page=${safePage}`);
  return listPayload(payload, slug, safePage);
}

export async function getCountry(slug: string, page = 1): Promise<ListPayload> {
  const safePage = normalizePage(page);
  const payload = await fetchJson(`${CATALOG_BASE}/api/country?slug=${encodeURIComponent(slug)}&page=${safePage}`);
  return listPayload(payload, slug, safePage);
}

export async function searchMovies(keyword: string, page = 1): Promise<ListPayload> {
  const q = keyword.trim();
  const safePage = normalizePage(page);
  if (!q) return { title: "Tìm kiếm", items: [], page: safePage };
  const payload = await fetchJson(
    `${CATALOG_BASE}/api/search?keyword=${encodeURIComponent(q)}&page=${safePage}`,
    { cache: "no-store" }
  );
  const result = listPayload(payload, `Tìm kiếm: ${q}`, safePage);
  return { ...result, title: `Tìm kiếm: ${q}` };
}

export async function getHome(): Promise<HomePayload> {
  const data = await fetchJson<any>(`${CATALOG_BASE}/api/home-data`);
  const hero = (Array.isArray(data?.heroMovies) ? data.heroMovies : []).map(normalizeCard);
  const section = (raw: any, title: string, href: string) => ({
    title,
    href,
    items: (Array.isArray(raw?.items) ? raw.items : []).map(normalizeCard) as MovieCard[]
  });
  return {
    hero,
    sections: [
      section(data?.newMovies, "Phim mới cập nhật", "/list/phim-moi-cap-nhat"),
      section(data?.phimLe, "Phim lẻ", "/list/phim-le"),
      section(data?.phimBo, "Phim bộ", "/list/phim-bo"),
      section(data?.hoatHinh, "Hoạt hình", "/list/hoat-hinh")
    ].filter((entry) => entry.items.length)
  };
}

export async function getMovie(slug: string): Promise<MovieDetail> {
  const safeSlug = String(slug || "").trim();
  const payload = await fetchJson<any>(`${CATALOG_BASE}/api/movie/${encodeURIComponent(safeSlug)}`);
  const movieRaw = payload?.movie || payload?.data?.item || payload?.data?.movie || {};
  const episodesRaw = payload?.episodes || movieRaw?.episodes || payload?.data?.episodes || [];

  const episodes: EpisodeServer[] = (Array.isArray(episodesRaw) ? episodesRaw : [])
    .map((server: any) => ({
      serverName: server?.server_name || server?.serverName || "Server",
      serverData: (server?.server_data || server?.serverData || []).map((ep: any, index: number) => ({
        name: normalizedEpisodeName(ep, index),
        slug: normalizedEpisodeSlug(ep, index),
        filename: ep?.filename || undefined,
        linkEmbed: ep?.link_embed || ep?.linkEmbed || undefined,
        linkM3u8: ep?.link_m3u8 || ep?.linkM3u8 || undefined
      }))
    }))
    .filter((server: EpisodeServer) => server.serverData.length);

  const movie: MovieDetail = {
    ...normalizeCard(movieRaw),
    content: movieRaw?.content || movieRaw?.description || undefined,
    actor: Array.isArray(movieRaw?.actor) ? movieRaw.actor.filter(Boolean) : [],
    director: Array.isArray(movieRaw?.director) ? movieRaw.director.filter(Boolean) : [],
    episodeTotal: movieRaw?.episode_total || movieRaw?.episodeTotal || undefined,
    categoryList: detailLabels(movieRaw?.category),
    countryList: detailLabels(movieRaw?.country),
    episodes
  };

  return movie;
}

/**
 * "Bạn cũng có thể thích" — canonical-catalog recommendations for a title,
 * resolved and cached by the Blueflare backend. TMDB ids are not unique across
 * movie/tv, so `type` selects the matching media family. Returns pre-signed
 * `MovieCard`s; fire-and-forget on the detail page.
 */
export async function getRecommendation(tmdbId: number | string, type = "movie"): Promise<MovieCard[]> {
  const id = String(tmdbId ?? "").trim();
  if (!id) return [];
  const mediaType = type === "tv" ? "tv" : "movie";
  const payload = await fetchJson<any>(`${CATALOG_BASE}/api/recommendation/${mediaType}/${encodeURIComponent(id)}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map(normalizeCard).filter((movie: MovieCard) => movie.slug);
}

type Taxonomy = { name: string; slug: string };

function taxonomyItems(payload: any): Taxonomy[] {
  const items = Array.isArray(payload) ? payload : payload?.data?.items || payload?.items || payload?.data || [];
  return (Array.isArray(items) ? items : [])
    .map((item: any) => ({ name: String(item?.name || "").trim(), slug: String(item?.slug || "").trim() }))
    .filter((item: Taxonomy) => item.name && item.slug);
}

export async function getCategories(): Promise<Taxonomy[]> {
  return taxonomyItems(await fetchJson(`${CATALOG_BASE}/api/categories`));
}

export async function getCountries(): Promise<Taxonomy[]> {
  return taxonomyItems(await fetchJson(`${CATALOG_BASE}/api/countries`));
}
