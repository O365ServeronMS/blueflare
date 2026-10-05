import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function stripHtml(value?: string) {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

type RatingSource = {
  imdbRating?: number | string | null;
  imdb_rating?: number | string | null;
  imdb_score?: number | string | null;
  tmdbRating?: number | string | null;
  tmdb_rating?: number | string | null;
  tmdb_vote_average?: number | string | null;
  vote_average?: number | string | null;
  imdb?: { rating?: number | string | null } | null;
  tmdb?: { vote_average?: number | string | null } | null;
  rating?: { imdb?: number | string | null; tmdb?: number | string | null } | number | string | null;
  ratings?: { imdb?: number | string | null; tmdb?: number | string | null } | null;
};

function normalizedRating(value?: number | string | null) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean || clean.toLowerCase() === "n/a") return undefined;
    value = clean;
  }
  const rating = Number(value);
  return Number.isFinite(rating) && rating > 0 ? rating : undefined;
}

function normalizedPercentage(value?: number | string | null) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean || clean.toLowerCase() === "n/a") return undefined;
    value = clean;
  }
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : undefined;
}

function formatRating(value: number) {
  return value.toFixed(1).replace(".0", "");
}

export function getDisplayRatings(movie: RatingSource) {
  const ratingObject = typeof movie.rating === "object" && movie.rating !== null ? movie.rating : undefined;
  const tmdb =
    normalizedRating(movie.tmdbRating) ||
    normalizedRating(movie.tmdb_rating) ||
    normalizedRating(movie.tmdb_vote_average) ||
    normalizedRating(movie.vote_average) ||
    normalizedRating(movie.tmdb?.vote_average) ||
    normalizedRating(ratingObject?.tmdb) ||
    normalizedRating(movie.ratings?.tmdb);
  const imdb =
    normalizedRating(movie.imdbRating) ||
    normalizedRating(movie.imdb_rating) ||
    normalizedRating(movie.imdb_score) ||
    normalizedRating(movie.imdb?.rating) ||
    normalizedRating(ratingObject?.imdb) ||
    normalizedRating(movie.ratings?.imdb);

  return [
    tmdb ? { label: "TMDB", score: tmdb, text: `TMDB ${formatRating(tmdb)}` } : null,
    imdb ? { label: "IMDb", score: imdb, text: `IMDb ${formatRating(imdb)}` } : null
  ].filter((rating): rating is { label: string; score: number; text: string } => Boolean(rating));
}

export function getDisplayRating(movie: RatingSource) {
  const imdb =
    normalizedRating(movie.imdbRating) ||
    normalizedRating(movie.imdb_rating) ||
    normalizedRating(movie.imdb_score) ||
    normalizedRating(movie.imdb?.rating) ||
    normalizedRating(typeof movie.rating === "object" && movie.rating !== null ? movie.rating.imdb : undefined) ||
    normalizedRating(movie.ratings?.imdb);

  if (imdb) return { label: "IMDb", score: imdb, text: `IMDb ${formatRating(imdb)}` };
  return null;
}

/** Below this the Tomatometer is "rotten"; Rotten Tomatoes' own threshold. */
const FRESH_THRESHOLD = 60;

type ScoreSource = RatingSource & {
  tomatometer?: number | string | null;
  audienceScore?: number | string | null;
};

/**
 * The two percentage badges shown above a card's title.
 *
 * Both values are Rotten Tomatoes percentages supplied by MDBList. They stay
 * independently optional because either source may be missing for a title.
 */
export function getScoreBadges(movie: ScoreSource) {
  const tomatometer = normalizedPercentage(movie.tomatometer);
  const audience = normalizedPercentage(movie.audienceScore);

  return {
    tomato: tomatometer !== undefined
      ? { score: Math.round(tomatometer), fresh: tomatometer >= FRESH_THRESHOLD }
      : undefined,
    popcorn: audience !== undefined
      ? { score: Math.round(audience) }
      : undefined
  };
}

export function ratingLabel(movie: RatingSource) {
  return getDisplayRating(movie)?.text || "";
}

export function normalizeEpisodeName(value?: string, index = 0) {
  const clean = (value || "").trim();
  if (!clean) return `Tập ${index + 1}`;
  return clean.toLowerCase().startsWith("tập") ? clean : `Tập ${clean}`;
}
