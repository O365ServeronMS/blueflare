import type { Episode, EpisodeServer, MovieDetail } from "@/lib/types";

const DEFAULT_EMBED_BASE_URL = "https://vsembed.ru";

function embedBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_VSEMBED_EMBED_BASE_URL;
  return String(configured || DEFAULT_EMBED_BASE_URL).replace(/\/$/, "");
}

function tmdbId(movie: Pick<MovieDetail, "tmdb">) {
  const id = movie.tmdb?.id;
  return id === undefined || id === null || String(id).trim() === "" ? "" : String(id).trim();
}

function imdbId(movie: Pick<MovieDetail, "imdb">) {
  const id = String(movie.imdb?.id || "").trim();
  return /^tt\d+$/i.test(id) ? id : "";
}

function identityQuery(movie: Pick<MovieDetail, "tmdb" | "imdb">) {
  const tmdb = tmdbId(movie);
  if (tmdb) return `tmdb=${encodeURIComponent(tmdb)}`;

  const imdb = imdbId(movie);
  if (imdb) return `imdb=${encodeURIComponent(imdb)}`;

  return "";
}

function episodeNumber(episode: Episode, index: number) {
  const text = `${episode.slug || ""} ${episode.name || ""} ${episode.filename || ""}`;
  const match = text.match(/(?:tap|ep|episode|e)[-_\s.]*(\d+)/i) || text.match(/\b(\d{1,4})\b/);
  return Math.max(1, Number(match?.[1] || index + 1) || index + 1);
}

function isSingleMovie(movie: Pick<MovieDetail, "type" | "episodeTotal">) {
  const type = String(movie.type || "").toLowerCase();
  const episodeTotal = String(movie.episodeTotal || "").toLowerCase();
  return /single|phim-le|movie/.test(type) || episodeTotal === "full" || episodeTotal === "1";
}

export function buildVsembedMovieUrl(movie: Pick<MovieDetail, "tmdb" | "imdb">) {
  const query = identityQuery(movie);
  return query ? `${embedBaseUrl()}/embed/movie?${query}&autoplay=0` : "";
}

export function buildVsembedEpisodeUrl(movie: Pick<MovieDetail, "tmdb" | "imdb">, season: number, episode: number) {
  const query = identityQuery(movie);
  if (!query) return "";

  const params = `${query}&season=${Math.max(1, season)}&episode=${Math.max(1, episode)}&autoplay=0&autonext=1`;
  return `${embedBaseUrl()}/embed/tv?${params}`;
}

export function buildVsembedServer(movie: MovieDetail): EpisodeServer | null {
  if (!identityQuery(movie)) return null;

  if (isSingleMovie(movie) || !movie.episodes.length) {
    const linkEmbed = buildVsembedMovieUrl(movie);
    return linkEmbed ? {
      serverName: "Vidsrc",
      serverData: [{ name: "Full", slug: "vsembed-full", linkEmbed }]
    } : null;
  }

  const sourceEpisodes = movie.episodes[0]?.serverData || [];
  const serverData = sourceEpisodes.map((episode, index) => {
    const linkEmbed = buildVsembedEpisodeUrl(movie, 1, episodeNumber(episode, index));
    return {
      name: episode.name || String(index + 1),
      slug: episode.slug ? `vsembed-${episode.slug}` : `vsembed-${index + 1}`,
      filename: episode.filename,
      linkEmbed
    };
  }).filter((episode) => episode.linkEmbed);

  return serverData.length ? { serverName: "Vidsrc", serverData } : null;
}
