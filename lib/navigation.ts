import type { MovieDetail } from "@/lib/types";

export const NAV_SOURCE_KEYS = ["home", "phim-le", "phim-bo", "tv-shows", "hoat-hinh"] as const;

export type NavSourceKey = typeof NAV_SOURCE_KEYS[number];

const SITE_ORIGIN = "https://phim.bluesia.net";
const SOURCE_KEY_SET = new Set<string>(NAV_SOURCE_KEYS);

function pathMatches(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function normalizeNavPath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname || "/";
}

export function normalizePage(value?: string | number | null) {
  const parsed = typeof value === "number" ? value : Number(String(value || "1").trim());
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

export function pageFromSearchParams(searchParams?: URLSearchParams | string | null) {
  if (!searchParams) return 1;
  const params = typeof searchParams === "string"
    ? new URLSearchParams(searchParams.replace(/^\?/, ""))
    : searchParams;
  return normalizePage(params.get("page"));
}

export function hrefWithPage(pathname: string, search: string, page: number) {
  const url = new URL(`${normalizeNavPath(pathname)}${search ? (search.startsWith("?") ? search : `?${search}`) : ""}`, SITE_ORIGIN);
  const normalizedPage = normalizePage(page);
  if (normalizedPage === 1) url.searchParams.delete("page");
  else url.searchParams.set("page", String(normalizedPage));
  return `${url.pathname}${url.search}`;
}

export function validNavSourceKey(value?: string | null) {
  const key = String(value || "").trim();
  return SOURCE_KEY_SET.has(key) ? key : "";
}

export function navSourceFromSearchParams(searchParams?: URLSearchParams | string | null) {
  if (!searchParams) return "";
  const params = typeof searchParams === "string" ? new URLSearchParams(searchParams.replace(/^\?/, "")) : searchParams;
  return navSourceFromReturnTo(params.get("returnTo")) || validNavSourceKey(params.get("from"));
}

export function navSourceFromHash(hash?: string | null) {
  const clean = String(hash || "").replace(/^#/, "");
  if (!clean) return "";
  return validNavSourceKey(new URLSearchParams(clean).get("from"));
}

export function safeInternalPath(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  try {
    const url = new URL(raw, SITE_ORIGIN);
    if (url.origin !== SITE_ORIGIN) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

export function isSafeInternalPath(value?: string | null) {
  return Boolean(safeInternalPath(value));
}

export function createReturnToPath(pathname: string, search = "") {
  const cleanSearch = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  return safeInternalPath(`${normalizeNavPath(pathname)}${cleanSearch}`);
}

export function returnToFromSearchParams(searchParams?: URLSearchParams | string | null) {
  if (!searchParams) return "";
  const params = typeof searchParams === "string" ? new URLSearchParams(searchParams.replace(/^\?/, "")) : searchParams;
  return safeInternalPath(params.get("returnTo"));
}

export function getSafeReturnTo(searchParams?: URLSearchParams | string | null) {
  return returnToFromSearchParams(searchParams) || null;
}

export function fallbackReturnToForSource(source?: string | null) {
  switch (validNavSourceKey(source)) {
    case "phim-le":
      return "/list/phim-le";
    case "phim-bo":
      return "/list/phim-bo";
    case "tv-shows":
      return "/list/tv-shows";
    case "hoat-hinh":
      return "/list/hoat-hinh";
    case "home":
      return "/";
    default:
      return "";
  }
}

export function getFallbackListPath({
  source,
  fallbackPath = "/"
}: {
  source?: string | null;
  fallbackPath?: string | null;
} = {}) {
  return fallbackReturnToForSource(source) || safeInternalPath(fallbackPath) || "/";
}

export function getFallbackListHref(context?: {
  source?: string | null;
  fallbackPath?: string | null;
}) {
  return getFallbackListPath(context);
}

export function getMovieBackHref(
  searchParams?: URLSearchParams | string | null,
  context?: {
    source?: string | null;
    fallbackPath?: string | null;
  }
) {
  return getSafeReturnTo(searchParams) || getFallbackListHref(context);
}

export function getBackHref(
  searchParams?: URLSearchParams | string | null,
  context?: {
    source?: string | null;
    fallbackPath?: string | null;
  }
) {
  return getMovieBackHref(searchParams, context);
}

export function navSourceFromReturnTo(returnTo?: string | null) {
  const path = safeInternalPath(returnTo);
  if (!path) return "";
  return navSourceFromPath(new URL(path, SITE_ORIGIN).pathname);
}

export function hrefWithReturnTo(href: string, returnTo?: string | null, fallbackSource?: string | null) {
  const url = new URL(href, SITE_ORIGIN);
  const legacyHashKey = navSourceFromHash(url.hash);
  const existingReturnTo = returnToFromSearchParams(url.searchParams);
  const targetReturnTo = existingReturnTo || safeInternalPath(returnTo) || fallbackReturnToForSource(fallbackSource || legacyHashKey);
  if (!targetReturnTo) return href;
  url.searchParams.set("returnTo", targetReturnTo);
  url.searchParams.delete("from");
  if (legacyHashKey) url.hash = "";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function navSourceFromPath(pathname: string) {
  const path = normalizeNavPath(pathname);
  if (path === "/") return "home";
  if (pathMatches(path, "/phim-le") || pathMatches(path, "/list/phim-le")) return "phim-le";
  if (pathMatches(path, "/phim-bo") || pathMatches(path, "/list/phim-bo")) return "phim-bo";
  if (pathMatches(path, "/tv-show") || pathMatches(path, "/tv-shows") || pathMatches(path, "/list/tv-shows")) return "tv-shows";
  if (pathMatches(path, "/hoat-hinh") || pathMatches(path, "/list/hoat-hinh")) return "hoat-hinh";
  return "";
}

function isChildRoute(pathname: string) {
  const path = normalizeNavPath(pathname);
  return path.startsWith("/movie/");
}

function normalizedLabels(movie?: Partial<MovieDetail> | null) {
  const values = [
    movie?.type,
    movie?.category,
    ...(movie?.categoryList || []).flatMap((item) => [item.slug, item.name])
  ];
  return values
    .filter(Boolean)
    .map((value) =>
      String(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
    )
    .join(" ");
}

export function inferNavSourceFromMovie(movie?: Partial<MovieDetail> | null) {
  const labels = normalizedLabels(movie);
  if (/(^|[\s_-])(hoat[\s_-]*hinh|anime|animation|cartoon)([\s_-]|$)/.test(labels)) return "hoat-hinh";
  if (/(^|[\s_-])(tv[\s_-]*shows?|shows?|tv[\s_-]*series)([\s_-]|$)/.test(labels)) return "tv-shows";
  if (/(^|[\s_-])(phim[\s_-]*bo|series|serial)([\s_-]|$)/.test(labels)) return "phim-bo";
  if (/(^|[\s_-])(phim[\s_-]*le|single|movie)([\s_-]|$)/.test(labels)) return "phim-le";

  const episodeTotal = String(movie?.episodeTotal || "").trim().toLowerCase();
  if (episodeTotal === "full" || episodeTotal === "1") return "phim-le";
  return "";
}

export function getActiveNavKey(
  pathname: string,
  searchParams?: URLSearchParams | string | null,
  movie?: Partial<MovieDetail> | null
) {
  const path = normalizeNavPath(pathname);
  if (path === "/") return "home";
  const pathSource = navSourceFromPath(path);
  if (pathSource) return pathSource;
  if (pathMatches(path, "/search")) return "search";
  if (pathMatches(path, "/settings")) return "settings";
  if (isChildRoute(path)) return navSourceFromSearchParams(searchParams) || inferNavSourceFromMovie(movie);
  return "";
}
