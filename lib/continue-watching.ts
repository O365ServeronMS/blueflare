/** Client-side helpers for resuming a title from GET /api/me/continue-watching. */

import type { MovieCard } from "@/lib/types";
import { hrefWithReturnTo } from "@/lib/navigation";

export const RESUME_MIN_PROGRESS = 0.02;
export const RESUME_MAX_PROGRESS = 0.9;

export type ContinueItem = {
  slug: string;
  episodeKey: string;
  positionSec: number;
  durationSec: number;
  progress: number;
};

export function parseContinueItem(body: unknown, slug: string): ContinueItem | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  for (const raw of items) {
    const item = raw as Record<string, unknown> | null;
    const movie = item?.movie as { slug?: unknown } | undefined;
    if (!item || movie?.slug !== slug) continue;
    const { episodeKey, positionSec, durationSec, progress } = item;
    if (typeof episodeKey !== "string" || !episodeKey) return null;
    if (typeof positionSec !== "number" || typeof durationSec !== "number" || typeof progress !== "number") return null;
    if (![positionSec, durationSec, progress].every(Number.isFinite)) return null;
    return { slug, episodeKey, positionSec, durationSec, progress };
  }
  return null;
}

/** Seconds to seek to, or null when the opened episode is not a resumable one. */
export function resumeTarget(item: ContinueItem | null, activeEpisodeKey: string): number | null {
  if (!item || !activeEpisodeKey || item.episodeKey !== activeEpisodeKey) return null;
  if (item.progress < RESUME_MIN_PROGRESS || item.progress >= RESUME_MAX_PROGRESS) return null;
  return item.positionSec >= 1 ? item.positionSec : null;
}

/** Episode key to suggest after a finished episode (server sends progress 0 + next key). */
export function nextEpisodeTarget(item: ContinueItem | null, activeEpisodeKey: string, knownKeys: readonly string[]): string | null {
  if (!item || item.progress !== 0 || item.episodeKey === activeEpisodeKey) return null;
  return knownKeys.includes(item.episodeKey) ? item.episodeKey : null;
}

export type ContinueEntry = { movie: MovieCard; item: ContinueItem };

/** All valid rows of the continue-watching response, in server order. */
export function parseContinueEntries(body: unknown): ContinueEntry[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: ContinueEntry[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const movie = (raw as { movie?: MovieCard } | null)?.movie;
    if (!movie || typeof movie.slug !== "string" || !movie.slug || seen.has(movie.slug)) continue;
    const item = parseContinueItem({ items: [raw] }, movie.slug);
    if (!item) continue;
    seen.add(movie.slug);
    out.push({ movie, item });
  }
  return out;
}

/** Same URL convention as ResumeActions; seeking still waits for the player's Play. */
export function continueCardHref(item: ContinueItem, returnTo?: string): string {
  const resume = resumeTarget(item, item.episodeKey) !== null ? "&resume=1" : "";
  return hrefWithReturnTo(`/movie/${item.slug}?ep=${encodeURIComponent(item.episodeKey)}&play=1${resume}#player`, returnTo);
}

export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

let inflight: Promise<unknown> | null = null;

/** One GET per page load, shared by every consumer; failures resolve to null and are retried later. */
export function fetchContinueWatching(): Promise<unknown> {
  if (!inflight) {
    inflight = fetch("/api/me/continue-watching", { credentials: "same-origin", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body) => {
        if (!body) inflight = null;
        return body;
      });
  }
  return inflight;
}
