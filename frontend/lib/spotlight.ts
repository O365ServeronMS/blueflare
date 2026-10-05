import type { MovieCard } from "@/lib/types";

export type SpotlightSource =
  | "latest"
  | "cinema"
  | "single"
  | "series"
  | "tv"
  | "animation"
  | "single-au-my"
  | "single-han-quoc"
  | string;

export type SpotlightCandidate = {
  movie: MovieCard;
  source: SpotlightSource;
  order?: number;
};

const SOURCE_BONUS: Record<string, number> = {
  latest: 12,
  cinema: 30,
  single: 8,
  series: 7,
  tv: 7,
  animation: 6,
  "single-au-my": 10,
  "single-han-quoc": 10
};

function normalizeText(value?: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stableNoise(seed?: string) {
  const text = seed || "film.bluesia.net";
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratingScore(movie: MovieCard) {
  const imdb = numberValue(movie.imdb?.rating);
  const tmdb = numberValue(movie.tmdb?.vote_average);
  const rating = Math.max(imdb, tmdb);
  if (!rating) return 0;
  if (rating >= 8.5) return 34;
  if (rating >= 8) return 30;
  if (rating >= 7.5) return 25;
  if (rating >= 7) return 20;
  if (rating >= 6.5) return 14;
  if (rating >= 6) return 9;
  return 4;
}

function recencyScore(movie: MovieCard) {
  const year = numberValue(movie.year);
  if (!year) return 0;
  const currentYear = new Date().getFullYear();
  const age = Math.max(0, currentYear - year);
  if (age <= 0) return 18;
  if (age === 1) return 14;
  if (age <= 2) return 10;
  if (age <= 5) return 6;
  return 0;
}

function qualityScore(movie: MovieCard) {
  const quality = normalizeText(movie.quality);
  const episode = normalizeText(movie.episodeCurrent);
  const lang = normalizeText(movie.lang);
  let score = 0;
  if (/4k|2160|uhd/.test(quality)) score += 10;
  else if (/hd|1080|720|fhd/.test(quality)) score += 7;
  if (/full|hoan tat|tron bo/.test(episode)) score += 8;
  if (/vietsub|thuyet minh|long tieng/.test(lang)) score += 4;
  return score;
}

function contentScore(movie: MovieCard, sources: string[]) {
  const type = normalizeText(movie.type);
  const category = normalizeText(movie.category);
  const country = normalizeText(movie.country);
  let score = 0;

  if (sources.includes("cinema") || /chieu rap/.test(category)) score += 26;
  if (/han quoc|au my|my|anh|phap|duc|canada|uc/.test(country)) score += 4;
  if (/single|phim le|movie/.test(type)) score += 3;
  if (/series|phim bo|tv shows?/.test(type)) score += 2;
  return score;
}

function imageScore(movie: MovieCard) {
  if (movie.thumb && movie.poster) return 7;
  if (movie.thumb || movie.poster) return 4;
  return -45;
}

export const TRENDING_SPOTLIGHT_BONUS = 22;

export function baseSpotlightScore(movie: MovieCard, sources: string[] = [], order = 0, trending = false) {
  const sourceScore = sources.reduce((total, source) => total + (SOURCE_BONUS[source] || 0), 0);
  const orderScore = Math.max(0, 10 - Math.floor(order / 3));
  const jitter = stableNoise(movie.slug) * 4;

  return (
    sourceScore +
    ratingScore(movie) +
    recencyScore(movie) +
    qualityScore(movie) +
    contentScore(movie, sources) +
    imageScore(movie) +
    orderScore +
    jitter +
    (trending ? TRENDING_SPOTLIGHT_BONUS : 0)
  );
}

function mergeText(a?: string, b?: string) {
  const parts = [...String(a || "").split(","), ...String(b || "").split(",")]
    .map((part) => part.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(", ") || undefined;
}

function mergeMovie(a: MovieCard, b: MovieCard): MovieCard {
  const aRating = Math.max(numberValue(a.imdb?.rating), numberValue(a.tmdb?.vote_average));
  const bRating = Math.max(numberValue(b.imdb?.rating), numberValue(b.tmdb?.vote_average));
  const primary = bRating > aRating ? b : a;
  const fallback = primary === a ? b : a;

  return {
    ...fallback,
    ...primary,
    name: primary.name || fallback.name,
    originName: primary.originName || fallback.originName,
    slug: primary.slug || fallback.slug,
    poster: primary.poster || fallback.poster,
    thumb: primary.thumb || fallback.thumb,
    year: primary.year || fallback.year,
    quality: primary.quality || fallback.quality,
    lang: primary.lang || fallback.lang,
    type: primary.type || fallback.type,
    status: primary.status || fallback.status,
    episodeCurrent: primary.episodeCurrent || fallback.episodeCurrent,
    time: primary.time || fallback.time,
    country: mergeText(primary.country, fallback.country),
    category: mergeText(primary.category, fallback.category),
    imdbRating: primary.imdbRating || primary.imdb?.rating || fallback.imdbRating || fallback.imdb?.rating,
    tmdbRating: primary.tmdbRating || primary.tmdb?.vote_average || fallback.tmdbRating || fallback.tmdb?.vote_average,
    tmdb: primary.tmdb?.vote_average || primary.tmdb?.vote_count ? primary.tmdb : fallback.tmdb,
    imdb: primary.imdb?.rating ? primary.imdb : fallback.imdb
  };
}

function movieRating(movie: MovieCard) {
  return Math.max(numberValue(movie.imdb?.rating), numberValue(movie.tmdb?.vote_average));
}

function pickPinnedAuMy<T extends { movie: MovieCard; order: number; sources: Set<string> }>(entries: T[]) {
  return entries.reduce<T | undefined>((best, entry) => {
    if (!entry.sources.has("single-au-my") || !(entry.movie.thumb || entry.movie.poster)) return best;
    if (!best) return entry;
    const rating = movieRating(entry.movie);
    const bestRating = movieRating(best.movie);
    if (rating > bestRating) return entry;
    if (rating === bestRating && entry.order < best.order) return entry;
    return best;
  }, undefined);
}

export function buildSmartSpotlight(candidates: SpotlightCandidate[], limit = 24, trendingIds: Set<string> = new Set()) {
  const bySlug = new Map<string, { movie: MovieCard; sources: Set<string>; firstOrder: number }>();

  candidates.forEach((candidate, index) => {
    const slug = candidate.movie.slug;
    if (!slug) return;

    const current = bySlug.get(slug);
    if (current) {
      current.movie = mergeMovie(current.movie, candidate.movie);
      current.sources.add(candidate.source);
      current.firstOrder = Math.min(current.firstOrder, candidate.order ?? index);
      return;
    }

    bySlug.set(slug, {
      movie: candidate.movie,
      sources: new Set([candidate.source]),
      firstOrder: candidate.order ?? index
    });
  });

  const ranked = Array.from(bySlug.values())
    .map((entry) => {
      const tmdbId = entry.movie.tmdb?.id;
      const trending = tmdbId != null && trendingIds.has(String(tmdbId));
      return {
        movie: entry.movie,
        sources: entry.sources,
        score: baseSpotlightScore(entry.movie, Array.from(entry.sources), entry.firstOrder, trending),
        order: entry.firstOrder
      };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const pinned = pickPinnedAuMy(ranked);
  const ordered = pinned ? [pinned, ...ranked.filter((entry) => entry !== pinned)] : ranked;

  return ordered.slice(0, limit).map((entry) => entry.movie);
}

export function splitLabels(value?: string) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizedLabelSet(value?: string) {
  return new Set(splitLabels(value).map(normalizeText).filter(Boolean));
}
