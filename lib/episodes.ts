import type { Episode, EpisodeServer, SourceEpisode } from "@/lib/types";

function cleanText(value?: string) {
  return String(value || "").trim();
}

function isGenericEpisodeLabel(value?: string) {
  const text = cleanText(value).toLowerCase();
  return !text || text === "tap phim" || text === "t\u1eadp phim";
}

export function normalizedEpisodeName(raw: SourceEpisode, index: number) {
  const name = cleanText(raw?.name);
  if (!isGenericEpisodeLabel(name)) return name;

  const slug = cleanText(raw?.slug).toLowerCase();
  if (slug === "full") return "Full";

  const filename = cleanText(raw?.filename);
  if (filename) return filename;

  return `Tap ${index + 1}`;
}

export function normalizedEpisodeSlug(raw: SourceEpisode, index: number) {
  const slug = cleanText(raw?.slug);
  if (slug) return slug;

  const name = normalizedEpisodeName(raw, index);
  if (name === "Full") return "full";

  return `ep-${index + 1}`;
}

export function episodeWatchKey(episode: Episode, index: number) {
  const slug = cleanText(episode.slug);
  if (slug && !isGenericEpisodeLabel(slug)) return slug;

  const name = cleanText(episode.name);
  if (name === "Full") return "full";

  return String(index);
}

export function findEpisodeByWatchKey(server?: EpisodeServer, key?: string) {
  if (!server?.serverData.length) return undefined;

  const value = cleanText(key);
  if (!value) return server.serverData[0];

  const found = server.serverData.find((episode, index) => {
    const candidates = [
      episodeWatchKey(episode, index),
      episode.slug,
      episode.name,
      episode.filename
    ].map(cleanText);
    return candidates.includes(value);
  });

  if (found) return found;

  const numericIndex = Number(value);
  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < server.serverData.length) {
    return server.serverData[numericIndex];
  }

  if (isGenericEpisodeLabel(value) && server.serverData.length === 1) {
    return server.serverData[0];
  }

  return server.serverData[0];
}

/** True only when `key` matches an episode of `server` (no first-episode fallback). */
export function serverHasEpisodeKey(server: EpisodeServer | undefined, key?: string) {
  const value = cleanText(key);
  if (!value || !server) return false;
  return server.serverData.some((episode, index) =>
    [episodeWatchKey(episode, index), episode.slug, episode.name, episode.filename].map(cleanText).includes(value)
  );
}

/** Server index for a stored watch: by serverName, else the first server holding the key, else 0. */
export function resolveServerIndex(servers: readonly EpisodeServer[], serverName?: string, key?: string) {
  const name = cleanText(serverName);
  if (name) {
    const byName = servers.findIndex((server) => cleanText(server.serverName) === name);
    if (byName >= 0) return byName;
  }
  const byKey = servers.findIndex((server) => serverHasEpisodeKey(server, key));
  return byKey >= 0 ? byKey : 0;
}
