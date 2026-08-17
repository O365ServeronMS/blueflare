import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft, Play } from "lucide-react";
import { ExpandableSynopsis } from "@/components/ExpandableSynopsis";
import { MovieActions } from "@/components/LocalMovieActions";
import { MoviePlayer } from "@/components/MoviePlayer";
import { getMovieServer } from "@/lib/catalog-server";
import { episodeWatchKey, findEpisodeByWatchKey } from "@/lib/episodes";
import { fallbackReturnToForSource, getBackHref, hrefWithReturnTo, inferNavSourceFromMovie, returnToFromSearchParams } from "@/lib/navigation";
import { getDisplayRating, stripHtml } from "@/lib/utils";
import type { MovieCard } from "@/lib/types";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function toMovieCard(movie: Awaited<ReturnType<typeof getMovieServer>>): MovieCard {
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

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  try {
    const movie = await getMovieServer((await params).slug);
    return {
      title: `${movie.name} — Bluesia Cinema`,
      description: stripHtml(movie.content) || `Xem ${movie.name} trên Bluesia Cinema.`,
      openGraph: { title: movie.name, description: stripHtml(movie.content) || undefined, images: movie.poster ? [movie.poster] : undefined }
    };
  } catch {
    return { title: "Không tìm thấy phim — Bluesia Cinema" };
  }
}

export default async function MoviePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  await connection();
  const { slug } = await params;
  const query = await searchParams;
  let movie;
  try {
    movie = await getMovieServer(slug);
  } catch {
    notFound();
  }

  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) urlParams.set(key, first(value));
  }
  const requestedServer = Number(urlParams.get("server") || "0");
  const serverIndex = Number.isInteger(requestedServer) && requestedServer >= 0 ? requestedServer : 0;
  const server = movie.episodes[serverIndex] || movie.episodes[0];
  const episode = findEpisodeByWatchKey(server, urlParams.get("ep") || undefined);
  const activeEpisodeKey = episode ? episodeWatchKey(episode, server?.serverData.indexOf(episode) ?? 0) : "";
  const navSource = returnToFromSearchParams(urlParams) ? undefined : inferNavSourceFromMovie(movie);
  const returnTo = returnToFromSearchParams(urlParams) || fallbackReturnToForSource(navSource);
  const backHref = getBackHref(urlParams, { source: navSource, fallbackPath: "/" });
  const movieCard = toMovieCard(movie);
  const displayRating = getDisplayRating(movie);
  const playerHref = hrefWithReturnTo(`/movie/${movie.slug}?server=${serverIndex}&ep=${encodeURIComponent(activeEpisodeKey)}&play=1#player`, returnTo, navSource);

  return (
    <article className="pb-10">
      <section className="relative min-h-[74vh] overflow-hidden bg-deep-space md:min-h-[78vh]">
        {movie.poster || movie.thumb ? <img src={movie.poster || movie.thumb} alt="" width={1280} height={720} loading="eager" fetchPriority="high" decoding="async" className="absolute inset-0 h-full w-full object-cover" /> : null}
        <div className="bf-detail-overlay absolute inset-0" />
        <div className="bf-content-width bf-page-gutter relative z-10 flex min-h-[74vh] flex-col justify-end pb-16 pt-24 md:min-h-[78vh] md:pb-24">
          <a href={backHref} data-nav-back aria-label="Quay lại danh sách phim" className="absolute left-[var(--bf-page-gutter)] top-20 grid h-11 w-11 place-items-center rounded bg-black/55 text-white transition hover:bg-graphite md:top-24"><ArrowLeft className="h-5 w-5" /></a>
          <div className="max-w-[42rem]">
            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-silver">Bluesia giới thiệu</p>
            <h1 className="mt-3 max-w-[13ch] text-[38px] font-black leading-[0.98] tracking-[-0.035em] text-white sm:text-[52px] lg:text-[64px]">{movie.name}</h1>
            {movie.originName && movie.originName !== movie.name ? <p className="mt-3 text-[14px] font-medium text-silver md:text-[16px]">{movie.originName}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-medium text-white">
              {displayRating ? <span>{displayRating.text}</span> : null}
              {movie.year ? <span>{movie.year}</span> : null}
              {movie.quality ? <span>{movie.quality}</span> : null}
              {movie.time ? <span>{movie.time}</span> : null}
              {movie.episodeCurrent ? <span className="text-silver">{movie.episodeCurrent}</span> : null}
            </div>
            <ExpandableSynopsis
              text={movie.content || "Thông tin nội dung đang được cập nhật."}
              className="mt-4 max-w-2xl"
              copyClassName="text-[14px] leading-6 text-silver md:text-[16px]"
            />
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a href={playerHref} className="bf-play-cta"><Play className="h-5 w-5 fill-current" aria-hidden="true" />Phát</a>
              <MovieActions movie={movieCard} />
            </div>
          </div>
        </div>
      </section>

      <section id="player" className="bf-content-width bf-page-gutter scroll-mt-16 pt-4">
        <MoviePlayer
          embedSrc={episode?.linkEmbed}
          episodeLabel={`${server?.serverName || "Server"} · ${episode?.name || "Tập phim"}`}
          hlsSrc={episode?.linkM3u8}
          initialOpen={urlParams.get("play") === "1"}
          movie={movieCard}
          poster={movie.thumb || movie.poster}
          title={`${movie.name} - ${episode?.name || "Tập phim"}`}
        />
      </section>

      <div className="bf-content-width bf-page-gutter">
        {movie.episodes.length ? (
          <section className="mt-10" aria-labelledby="episodes-heading">
            <h2 id="episodes-heading" className="text-[24px] font-bold text-white">Chọn nguồn Phát</h2>
            <div className="mt-5 space-y-5">
              {movie.episodes.map((episodeServer, episodeServerIndex) => <div key={`srv-${episodeServerIndex}`}><h3 className="mb-2 text-[13px] font-bold text-silver">{episodeServer.serverName}</h3><div className="no-scrollbar flex gap-2 overflow-x-auto pb-2">{episodeServer.serverData.map((item, itemIndex) => { const itemKey = episodeWatchKey(item, itemIndex); const active = episodeServerIndex === serverIndex && itemKey === activeEpisodeKey; const href = hrefWithReturnTo(`/movie/${movie.slug}?server=${episodeServerIndex}&ep=${encodeURIComponent(itemKey)}&play=1#player`, returnTo, navSource); return <a key={`${episodeServerIndex}-${itemKey}`} href={href} aria-current={active ? "true" : undefined} className={active ? "min-w-12 shrink-0 rounded bg-netflix-red px-3 py-2.5 text-center text-[13px] font-bold text-white" : "min-w-12 shrink-0 rounded bg-graphite px-3 py-2.5 text-center text-[13px] font-bold text-silver transition hover:bg-charcoal hover:text-white"}>{item.name || itemIndex + 1}</a>; })}</div></div>)}
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
}
