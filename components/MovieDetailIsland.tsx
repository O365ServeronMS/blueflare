"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, Play } from "lucide-react";
import { MovieActions } from "@/components/LocalMovieActions";
import { SectionRow } from "@/components/SectionRow";
import { MoviePlayer } from "@/components/MoviePlayer";
import { getMovie, getRecommendation } from "@/lib/catalog";
import { episodeWatchKey, findEpisodeByWatchKey } from "@/lib/episodes";
import {
  fallbackReturnToForSource,
  getBackHref,
  hrefWithReturnTo,
  inferNavSourceFromMovie,
  navSourceFromSearchParams,
  returnToFromSearchParams
} from "@/lib/navigation";
import { isMobilePlaybackUserAgent, normalizePlaybackUrl } from "@/lib/playback";
import type { MovieCard, MovieDetail } from "@/lib/types";
import { getDisplayRating, stripHtml } from "@/lib/utils";

const VIDSRC_HOSTS = new Set(["vsembed.ru", "vsembed.su", "vidsrc-embed.ru", "vidsrc-embed.su", "vidsrcme.su", "vsrc.su"]);
const MOBILE_VIDSRC_HOST = "vsembed.su";

function slugFromPath() {
  const match = window.location.pathname.match(/^\/movie\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function displayEpisodeServerName(serverName?: string) {
  const name = String(serverName || "").trim();
  return name || "Server";
}

function resolveEmbedUrl(src: string | undefined, params: URLSearchParams, mobileUA: boolean) {
  const normalized = normalizePlaybackUrl(src);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (!VIDSRC_HOSTS.has(url.hostname)) return normalized;
    const mirror = String(params.get("mirror") || "").trim().toLowerCase();
    if (VIDSRC_HOSTS.has(mirror)) url.hostname = mirror;
    else if (mobileUA) url.hostname = MOBILE_VIDSRC_HOST;
    url.searchParams.set("autoplay", "0");
    return url.toString();
  } catch {
    return undefined;
  }
}

function toMovieCard(movie: MovieDetail): MovieCard {
  return {
    name: movie.name,
    originName: movie.originName,
    slug: movie.slug,
    poster: movie.poster,
    thumb: movie.thumb,
    year: movie.year,
    quality: movie.quality,
    lang: movie.lang,
    type: movie.type,
    status: movie.status,
    episodeCurrent: movie.episodeCurrent,
    time: movie.time,
    imdbRating: movie.imdbRating,
    tmdbRating: movie.tmdbRating,
    tmdb: movie.tmdb,
    imdb: movie.imdb,
    country: movie.country,
    category: movie.category
  };
}

function MovieDetailSkeleton() {
  return (
    <article>
      <div className="h-[420px] w-full animate-pulse bg-graphite" />
      <div className="space-y-3 px-4 pt-6">
        <div className="h-7 w-2/3 animate-pulse rounded bg-graphite" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-graphite" />
        <div className="h-12 w-40 animate-pulse rounded bg-graphite" />
      </div>
    </article>
  );
}

export function MovieDetailIsland() {
  const [movie, setMovie] = useState<MovieDetail | null>(null);
  const [recommendations, setRecommendations] = useState<MovieCard[]>([]);
  const [error, setError] = useState(false);
  const [synopsisOpen, setSynopsisOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const slug = slugFromPath();
    if (!slug) {
      setError(true);
      return;
    }
    getMovie(slug)
      .then((data) => {
        if (!active) return;
        setMovie(data);
        document.title = `Bluesia Cinema - ${data.originName || data.name}`;
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  // Episode selection reloads the shell with a `#player` hash, but the native
  // anchor scroll misses because detail is client-rendered. Once rendered, bring
  // the player into view with a gentle smooth scroll so the user can press play.
  useEffect(() => {
    if (!movie || window.location.hash !== "#player") return;
    const player = document.getElementById("player");
    if (!player) return;
    const raf = requestAnimationFrame(() => {
      player.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(raf);
  }, [movie?.slug]);

  // Fire-and-forget recommendations ("Bạn cũng có thể thích"). Must not block render.
  useEffect(() => {
    const tmdbId = movie?.tmdb?.id;
    if (!tmdbId) return;
    let active = true;
    setRecommendations([]);
    getRecommendation(tmdbId, movie?.tmdb?.type)
      .then((items) => active && setRecommendations(items))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [movie?.tmdb?.id, movie?.tmdb?.type]);

  if (error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4 text-center">
        <p className="text-lg font-semibold text-silver">Không thể tải phim. Vui lòng thử lại sau.</p>
      </div>
    );
  }

  if (!movie) return <MovieDetailSkeleton />;

  const params = new URLSearchParams(window.location.search);
  const requestedServerIndex = Number(params.get("server") || "0");
  const serverIndex = Number.isInteger(requestedServerIndex) && requestedServerIndex >= 0 ? requestedServerIndex : 0;
  const server = movie.episodes[serverIndex] || movie.episodes[0];
  const epKey = params.get("ep") || undefined;
  const episode = findEpisodeByWatchKey(server, epKey);
  const requestedPlayer = String(params.get("player") || "").toLowerCase();
  const preferredMode = requestedPlayer === "embed" ? "iframe" : requestedPlayer === "hls" ? "hls" : undefined;
  const mobileUA = isMobilePlaybackUserAgent(navigator.userAgent || "");
  const playerEmbed = resolveEmbedUrl(episode?.linkEmbed, params, mobileUA);
  const m3u8 = episode?.linkM3u8;
  const initialPlayerOpen = params.get("play") === "1";

  const heroImage = movie.poster || movie.thumb;
  const posterImage = movie.thumb || movie.poster;
  const playerPoster = movie.thumb || movie.poster || undefined;
  const displayRating = getDisplayRating(movie);
  const navSourceKey = navSourceFromSearchParams(params) || inferNavSourceFromMovie(movie);
  const returnTo = returnToFromSearchParams(params) || fallbackReturnToForSource(navSourceKey);
  const backHref = getBackHref(params, { source: navSourceKey, fallbackPath: "/" });
  const selectedEpisodeLabel = `${displayEpisodeServerName(server?.serverName)} · ${episode?.name || "Tập phim"}`;
  const movieCard = toMovieCard(movie);

  function replacePlayerNavigation(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.location.replace(href);
  }

  function selectEpisode(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    replacePlayerNavigation(event, href);
  }

  const activeEpisodeKey = episode ? episodeWatchKey(episode, server?.serverData.indexOf(episode) ?? 0) : "";
  const heroPlayHref = hrefWithReturnTo(
    `/movie/${movie.slug}?server=${serverIndex}&ep=${encodeURIComponent(activeEpisodeKey)}&play=1#player`,
    returnTo,
    navSourceKey
  );

  return (
    <article className="pb-8">
      <section className="relative min-h-[74vh] overflow-hidden bg-deep-space md:min-h-[78vh]">
        {heroImage ? (
          <img
            src={heroImage}
            alt=""
            width={1280}
            height={720}
            className="absolute inset-0 h-full w-full object-cover"
            fetchPriority="high"
            loading="eager"
            decoding="async"
            data-movie-poster
            data-fallback-src={movie.thumb || undefined}
            data-original-src={heroImage || undefined}
            data-placeholder-src="/image-placeholder.svg"
          />
        ) : null}
        <div className="bf-detail-overlay absolute inset-0" />
        <div className="bf-content-width bf-page-gutter relative z-10 flex min-h-[74vh] flex-col justify-end pb-16 pt-24 md:min-h-[78vh] md:pb-24">
          <a href={backHref} data-nav-back aria-label="Quay lại danh sách phim" className="absolute left-[var(--bf-page-gutter)] top-20 grid h-11 w-11 place-items-center rounded bg-black/55 text-white transition hover:bg-graphite md:top-24">
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div className="max-w-[42rem]">
            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-silver">Blueflare giới thiệu</p>
            <h1 className="mt-3 max-w-[13ch] text-[38px] font-black leading-[0.98] tracking-[-0.035em] text-white sm:text-[52px] lg:text-[64px]">{movie.name}</h1>
            {movie.originName && movie.originName !== movie.name ? <p className="mt-3 text-[14px] font-medium text-silver md:text-[16px]">{movie.originName}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-medium text-white">
              {displayRating ? <span>{displayRating.text}</span> : null}
              {movie.year ? <span>{movie.year}</span> : null}
              {movie.quality ? <span>{movie.quality}</span> : null}
              {movie.time ? <span>{movie.time}</span> : null}
              {movie.episodeCurrent ? <span className="text-silver">{movie.episodeCurrent}</span> : null}
            </div>
            <p className="mt-4 line-clamp-3 max-w-2xl text-[14px] leading-6 text-silver md:text-[16px]">{stripHtml(movie.content) || "Thông tin nội dung đang được cập nhật."}</p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a href={heroPlayHref} onClick={(event) => replacePlayerNavigation(event, heroPlayHref)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded bg-white px-5 py-2.5 text-[14px] font-bold text-black transition hover:bg-silver">
                <Play className="h-5 w-5 fill-current" aria-hidden="true" />
                Phát
              </a>
              <MovieActions movie={movieCard} />
            </div>
          </div>
        </div>
      </section>

      <section id="player" className="bf-content-width bf-page-gutter scroll-mt-16 pt-2">
        <MoviePlayer
          embedSrc={playerEmbed}
          episodeLabel={selectedEpisodeLabel}
          hlsSrc={m3u8}
          initialOpen={initialPlayerOpen}
          movie={movieCard}
          poster={playerPoster}
          preferredMode={preferredMode}
          title={`${movie.name} - ${episode?.name || "Tập phim"}`}
        />
      </section>

      <div className="bf-content-width bf-page-gutter">
        {movie.episodes.length ? (
          <section className="mt-10" aria-labelledby="episodes-heading">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Tiếp tục xem</p>
                <h2 id="episodes-heading" className="mt-1 text-[24px] font-bold text-white">Tập phim</h2>
              </div>
              <p className="text-[12px] text-ash">{selectedEpisodeLabel}</p>
            </div>
            <div className="mt-5 space-y-5">
              {movie.episodes.map((episodeServer, episodeServerIndex) => (
                <div key={`srv-${episodeServerIndex}`}>
                  <h3 className="mb-2 text-[13px] font-bold text-silver">{displayEpisodeServerName(episodeServer.serverName)}</h3>
                  <div className="no-scrollbar flex gap-2 overflow-x-auto pb-2">
                    {episodeServer.serverData.map((item, itemIndex) => {
                      const itemKey = episodeWatchKey(item, itemIndex);
                      const active = episodeServerIndex === serverIndex && (itemKey === activeEpisodeKey || (itemIndex === 0 && !epKey));
                      const episodeHref = hrefWithReturnTo(`/movie/${movie.slug}?server=${episodeServerIndex}&ep=${encodeURIComponent(itemKey)}&play=1#player`, returnTo, navSourceKey);
                      return (
                        <a
                          key={itemKey}
                          href={episodeHref}
                          onClick={(event) => selectEpisode(event, episodeHref)}
                          aria-current={active ? "true" : undefined}
                          className={active
                            ? "min-w-12 shrink-0 rounded bg-netflix-red px-3 py-2.5 text-center text-[13px] font-bold text-white"
                            : "min-w-12 shrink-0 rounded bg-graphite px-3 py-2.5 text-center text-[13px] font-bold text-silver transition hover:bg-charcoal hover:text-white"}
                        >
                          {item.name || itemIndex + 1}
                        </a>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mt-12 grid gap-10 border-t border-white/10 pt-9 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.75fr)]">
          <div>
            <h2 className="text-[24px] font-bold text-white">Giới thiệu</h2>
            <div className={`movie-synopsis mt-4${synopsisOpen ? " is-expanded" : ""}`}>
              <p className="movie-synopsis-copy max-w-3xl text-[15px] leading-7 text-silver">{stripHtml(movie.content) || "Thông tin nội dung đang được cập nhật."}</p>
              <button type="button" aria-expanded={synopsisOpen} onClick={() => setSynopsisOpen((open) => !open)} className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-bold text-white transition hover:text-netflix-red">
                {synopsisOpen ? "Thu gọn" : "Xem thêm"}
                <ChevronDown className="movie-synopsis-icon h-4 w-4" />
              </button>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-3 gap-y-2 text-[13px] text-silver">
              {movie.categoryList?.map((item) => <span key={`c-${item.slug}`}>{item.name}</span>)}
              {movie.countryList?.map((item) => <span key={`n-${item.slug}`}>{item.name}</span>)}
            </div>
          </div>
          <dl className="space-y-4 text-[13px] leading-6">
            {movie.actor?.length ? <div><dt className="font-bold text-white">Diễn viên</dt><dd className="mt-1 text-silver">{movie.actor.slice(0, 12).join(", ")}</dd></div> : null}
            {movie.director?.length ? <div><dt className="font-bold text-white">Đạo diễn</dt><dd className="mt-1 text-silver">{movie.director.slice(0, 8).join(", ")}</dd></div> : null}
          </dl>
        </section>
      </div>

      {recommendations.length ? <SectionRow title="Có thể bạn sẽ thích" href="/list/phim-moi-cap-nhat" items={recommendations} returnTo={returnTo} /> : null}
    </article>
  );
}
