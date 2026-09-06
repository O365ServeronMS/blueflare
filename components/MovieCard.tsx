import { Play } from "lucide-react";
import type { MovieCard as MovieCardType } from "@/lib/types";
import { hrefWithReturnTo } from "@/lib/navigation";
import { getDisplayRating } from "@/lib/utils";
import { ScoreBadges } from "@/components/ScoreBadges";

const LOCAL_IMAGE_PLACEHOLDER = "/image-placeholder.svg";

function validHttpImage(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function movieStatus(movie: MovieCardType) {
  const episode = String(movie.episodeCurrent || "").trim();
  if (/trailer/i.test(episode)) return "TRAILER";
  const episodeMatch = episode.match(/t(?:ập|ap)\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (episodeMatch) return `TẬP ${episodeMatch[1]}`;
  return /(?:^|\b)(?:f?hd)(?:\b|$)/i.test(String(movie.quality || "")) ? "HD" : "";
}

export function MovieCard({
  movie,
  compact = false,
  headingLevel = 3,
  priority = false,
  navSourceKey = "",
  returnTo = "",
  variant = "poster",
  rank
}: {
  movie: MovieCardType;
  compact?: boolean;
  headingLevel?: 2 | 3;
  priority?: boolean;
  navSourceKey?: string;
  returnTo?: string;
  variant?: "poster" | "landscape";
  /** Trending position; renders the Top-10 numeral inside the poster. */
  rank?: number;
}) {
  const portrait = validHttpImage(movie.thumb);
  const landscape = validHttpImage(movie.poster);
  const primaryUrl = variant === "landscape" ? landscape || portrait : portrait || landscape;
  const fallbackUrl = variant === "landscape" ? portrait : landscape;
  const imageSrc = primaryUrl || LOCAL_IMAGE_PLACEHOLDER;
  const displayRating = getDisplayRating(movie);
  const status = movieStatus(movie);
  const detailHref = hrefWithReturnTo(`/movie/${movie.slug}`, returnTo, navSourceKey);
  const Title = headingLevel === 2 ? "h2" : "h3";

  if (variant === "landscape") {
    return (
      <a href={detailHref} className="bf-media-card group block min-w-0 rounded" aria-label={`Xem chi tiết ${movie.name}`}>
        <article className="relative aspect-video overflow-hidden rounded bg-graphite">
          <img
            src={imageSrc}
            alt={movie.name}
            width={640}
            height={360}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : undefined}
            decoding="async"
            data-movie-poster
            data-fallback-src={fallbackUrl || undefined}
            data-original-src={primaryUrl || undefined}
            data-placeholder-src={LOCAL_IMAGE_PLACEHOLDER}
            className="h-full w-full object-cover"
          />
          <span className="bf-card-vignette absolute inset-0 opacity-80 transition-opacity group-hover:opacity-100" aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
            <div className="min-w-0">
              <Title className="line-clamp-1 text-body font-bold leading-tight text-chalk-white">{movie.name}</Title>
              <p className="mt-1 flex items-center gap-2 text-micro text-silver">
                <ScoreBadges movie={movie} className="!text-micro" reserveSpace={false} />
                {movie.year ? <span>{movie.year}</span> : null}
                {status ? <span>{status}</span> : null}
                {displayRating ? <span className="font-bold text-luxury-gold">{displayRating.score.toFixed(1)}</span> : null}
              </p>
            </div>
            <span className="hidden h-9 w-9 shrink-0 place-items-center rounded-full bg-netflix-red text-chalk-white transition group-hover:grid group-focus-visible:grid">
              <Play className="ml-0.5 h-4 w-4 fill-current" aria-hidden="true" />
            </span>
          </div>
        </article>
      </a>
    );
  }

  return (
    <a href={detailHref} className="bf-media-card group block min-w-0">
      <article>
        <div className="bf-poster-frame relative aspect-[2/3] overflow-hidden rounded bg-graphite">
          <img
            src={imageSrc}
            alt={movie.name}
            width={400}
            height={600}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : undefined}
            decoding="async"
            data-movie-poster
            data-fallback-src={fallbackUrl || undefined}
            data-original-src={primaryUrl || undefined}
            data-placeholder-src={LOCAL_IMAGE_PLACEHOLDER}
            className="h-full w-full object-cover"
          />
          {rank ? (
            <span className="bf-rank pointer-events-none absolute bottom-0 left-1 z-10" aria-hidden="true">{rank}</span>
          ) : null}
        </div>
        <Title className={compact ? "mt-2 line-clamp-1 text-control font-medium text-chalk-white" : "mt-2 line-clamp-1 text-body font-medium text-chalk-white"}>{movie.name}</Title>
        <p className="bf-card-meta">
          <ScoreBadges movie={movie} className="!text-caption" reserveSpace={false} />
          {displayRating ? <span className="font-bold text-luxury-gold">{displayRating.score.toFixed(1)}</span> : null}
          {status ? <span>{status}</span> : null}
          {movie.year ? <span>{movie.year}</span> : null}
        </p>
      </article>
    </a>
  );
}
