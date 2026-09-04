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

type ScoreSource = RatingSource & { tomatometer?: number | string | null };

/**
 * The two percentage badges shown above a card's title.
 *
 * The tomato is the Rotten Tomatoes critic score OMDb supplies, and is absent
 * for most of this catalog — a 60-title probe of the live site found one for
 * 25% of trending rows and 15% of phim-le rows. The popcorn slot is *not* the
 * Rotten Tomatoes audience score: OMDb stopped returning it in 2017 and every
 * `tomatoUser*` field now answers "N/A". It is the TMDB user score instead,
 * which is the same kind of measure (a public vote) on a 0-10 scale.
 */
export function getScoreBadges(movie: ScoreSource) {
  const tomatometer = normalizedRating(movie.tomatometer);
  const tmdb =
    normalizedRating(movie.tmdbRating) ||
    normalizedRating(movie.tmdb_rating) ||
    normalizedRating(movie.tmdb_vote_average) ||
    normalizedRating(movie.vote_average) ||
    normalizedRating(movie.tmdb?.vote_average);

  return {
    tomato: tomatometer !== undefined && tomatometer <= 100
      ? { score: Math.round(tomatometer), fresh: tomatometer >= FRESH_THRESHOLD }
      : undefined,
    popcorn: tmdb !== undefined && tmdb <= 10
      ? { score: Math.round(tmdb * 10) }
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

