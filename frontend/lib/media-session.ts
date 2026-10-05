/**
 * iOS lock-screen (MediaSession) metadata for the native <video> playback
 * path. Pure functions only — no DOM/navigator access here, so they're
 * testable and the browser-only bits live in NowPlayingMetadata.tsx.
 */

export type NowPlayingArtwork = {
  src: string;
  sizes?: string;
  type?: string;
};

export type NowPlayingInput = {
  name: string;
  originName?: string;
  type?: string;
  episodeName?: string;
  artworkSrc?: string;
};

export type NowPlayingMetadata = {
  title: string;
  artist: string;
  album: string;
  artwork: NowPlayingArtwork[];
};

const NAME_HAS_SEASON = /ph[aầ]n\s*\d+/i;
const ORIGIN_HAS_SEASON = /\b(?:season|part)\s*(\d+)\b/i;

/** Append "(Phần N)" from origin_name's "Season N"/"Part N" only when the
 * Vietnamese name doesn't already carry a season marker. With today's
 * catalog this is a no-op for ~all series — name arrives with "(Phần N)"
 * already — but providers have changed this shape before. */
export function titleWithSeason(name: string, originName?: string) {
  const cleanName = String(name || "").trim();
  if (!cleanName || NAME_HAS_SEASON.test(cleanName)) return cleanName;

  const match = String(originName || "").match(ORIGIN_HAS_SEASON);
  const season = match?.[1];
  return season ? `${cleanName} (Phần ${season})` : cleanName;
}

function isEpisodicType(type?: string) {
  return Boolean(type) && type !== "single";
}

export function buildNowPlaying(input: NowPlayingInput): NowPlayingMetadata {
  const title = titleWithSeason(input.name, input.originName);
  const episodeName = String(input.episodeName || "").trim();
  const hasRealEpisode = Boolean(episodeName) && episodeName.toLowerCase() !== "full";
  const originDiffersFromName = Boolean(input.originName) && input.originName !== input.name;

  const artist = isEpisodicType(input.type) && hasRealEpisode
    ? episodeName
    : originDiffersFromName
      ? (input.originName as string)
      : "";

  const artwork: NowPlayingArtwork[] = [];
  if (input.artworkSrc) artwork.push({ src: input.artworkSrc, sizes: "480x720", type: "image/webp" });
  // iOS artwork support for WebP is unverified — a PNG fallback lets it pick
  // whichever it can decode instead of showing no artwork at all.
  artwork.push({ src: "/icon-512.png", sizes: "512x512", type: "image/png" });

  return { title, artist, album: "Bluesia Cinema", artwork };
}
