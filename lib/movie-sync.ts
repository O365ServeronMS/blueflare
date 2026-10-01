import type { MovieCard } from "@/lib/types";
import { normalizeCard } from "@/lib/catalog";

/** Pure helpers behind the guest/account favorites + history store. */

export const LIST_LIMIT = 100;
export const CARD_CACHE_LIMIT = 300;
export const IMPORT_LOCK_TTL_MS = 60_000;

/** Last watched episode of a movie: server label, episode watch key, display name. */
export type EpisodeRef = { server: string; key: string; name: string };
export type StoredMovie = MovieCard & { savedAt: number; ep?: EpisodeRef };
export type SlugEntry = { slug: string; savedAt: number; ep?: EpisodeRef };
export type ImportEpisode = { serverName: string; episodeKey: string; episodeName: string };
export type ImportPayload = {
  favorites: { slug: string; savedAt: number }[];
  history: { slug: string; savedAt: number; ep?: ImportEpisode }[];
};

export const EP_FIELD_MAX = 100;

/** Validates untrusted input (old localStorage rows, server rows) into an EpisodeRef or undefined. */
export function toEpisodeRef(value: unknown): EpisodeRef | undefined {
  const v = value as { server?: unknown; key?: unknown; name?: unknown } | null | undefined;
  if (!v || typeof v.key !== "string" || typeof v.name !== "string") return undefined;
  const key = v.key.trim().slice(0, EP_FIELD_MAX);
  const name = v.name.trim().slice(0, EP_FIELD_MAX);
  if (!key || !name) return undefined;
  const server = typeof v.server === "string" ? v.server.trim().slice(0, EP_FIELD_MAX) : "";
  return { server, key, name };
}

/** Body for PUT /api/me/history/{slug}; serverName is omitted when unknown. */
export function toEpisodeBody(ep: EpisodeRef): { serverName?: string; episodeKey: string; episodeName: string } {
  return { ...(ep.server ? { serverName: ep.server } : {}), episodeKey: ep.key, episodeName: ep.name };
}

/** Accepts epoch ms, numeric or ISO strings; falls back to `fallback`. */
export function toSavedAtMs(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Guest localStorage rows -> `{slug,savedAt}` (dedupe by slug, newest first, capped). */
export function toSlugEntries(items: readonly { slug?: unknown; savedAt?: unknown; ep?: unknown }[], limit = LIST_LIMIT): SlugEntry[] {
  const seen = new Set<string>();
  const out: SlugEntry[] = [];
  for (const item of items) {
    if (!item || typeof item.slug !== "string" || !item.slug || seen.has(item.slug)) continue;
    seen.add(item.slug);
    const ep = toEpisodeRef(item.ep);
    out.push({ slug: item.slug, savedAt: toSavedAtMs(item.savedAt), ...(ep ? { ep } : {}) });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out.slice(0, limit);
}

/** Body for POST /api/me/import built from the guest lists. */
export function buildImportPayload(
  favorites: readonly { slug?: unknown; savedAt?: unknown; ep?: unknown }[],
  history: readonly { slug?: unknown; savedAt?: unknown; ep?: unknown }[]
): ImportPayload {
  return {
    favorites: toSlugEntries(favorites).map(({ slug, savedAt }) => ({ slug, savedAt })),
    history: toSlugEntries(history).map(({ slug, savedAt, ep }) => ({ slug, savedAt, ...(ep ? { ep: { serverName: ep.server, episodeKey: ep.key, episodeName: ep.name } } : {}) }))
  };
}

/** Server list response -> entries. History rows use `watchedAt`, favorites `savedAt`. */
export function parseServerItems(body: unknown): SlugEntry[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return toSlugEntries(
    items.map((row) => {
      const r = (row || {}) as { slug?: unknown; savedAt?: unknown; watchedAt?: unknown; at?: unknown; serverName?: unknown; episodeKey?: unknown; episodeName?: unknown };
      return { slug: r.slug, savedAt: r.savedAt ?? r.watchedAt ?? r.at, ep: { server: r.serverName, key: r.episodeKey, name: r.episodeName } };
    }),
    500
  );
}

/**
 * Put `slug` at the head of the list (dedup). A plain re-add (no `ep`) keeps the
 * episode already stored for that slug; a new `ep` replaces it.
 */
export function pushToHead(list: readonly SlugEntry[], slug: string, now: number, limit = LIST_LIMIT, ep?: EpisodeRef): SlugEntry[] {
  const kept = ep ?? list.find((entry) => entry.slug === slug)?.ep;
  return [{ slug, savedAt: now, ...(kept ? { ep: kept } : {}) }, ...list.filter((entry) => entry.slug !== slug)].slice(0, limit);
}

/** Guest history: put `movie` first, keeping its previous episode unless `ep` is given. */
export function pushGuestHistory(list: readonly StoredMovie[], movie: MovieCard, now: number, ep?: EpisodeRef): StoredMovie[] {
  const kept = ep ?? toEpisodeRef(list.find((item) => item.slug === movie.slug)?.ep);
  return [{ ...movie, savedAt: now, ...(kept ? { ep: kept } : {}) }, ...list.filter((item) => item.slug !== movie.slug)];
}

export function removeSlug(list: readonly SlugEntry[], slug: string): SlugEntry[] {
  return list.filter((entry) => entry.slug !== slug);
}

/** Add a card to the slug->card cache, evicting the oldest inserted beyond `limit`. */
export function upsertCard(cache: Readonly<Record<string, MovieCard>>, card: MovieCard, limit = CARD_CACHE_LIMIT): Record<string, MovieCard> {
  const { [card.slug]: _old, ...rest } = cache;
  void _old;
  const next = { ...rest, [card.slug]: card };
  const keys = Object.keys(next);
  if (keys.length <= limit) return next;
  const trimmed: Record<string, MovieCard> = {};
  for (const key of keys.slice(keys.length - limit)) trimmed[key] = next[key];
  return trimmed;
}

/** Resolve slug entries to cards; entries without a cached card are dropped. */
export function resolveCards(entries: readonly SlugEntry[], cache: Readonly<Record<string, MovieCard>>): StoredMovie[] {
  const out: StoredMovie[] = [];
  for (const entry of entries) {
    const card = cache[entry.slug];
    if (card && isNormalizedCard(card)) out.push({ ...card, savedAt: entry.savedAt, ...(entry.ep ? { ep: entry.ep } : {}) });
  }
  return out;
}

/**
 * Apply `next` immediately, run the request, and restore `previous` if it fails.
 * A newer write to the same state wins: rollback only happens when `isCurrent()`
 * still says our optimistic value is the live one.
 */
export async function runOptimistic<T>(opts: {
  previous: T;
  next: T;
  apply: (value: T) => void;
  request: () => Promise<boolean>;
  isCurrent?: () => boolean;
}): Promise<boolean> {
  opts.apply(opts.next);
  let ok = false;
  try {
    ok = await opts.request();
  } catch {
    ok = false;
  }
  if (!ok && (opts.isCurrent ? opts.isCurrent() : true)) opts.apply(opts.previous);
  return ok;
}

/** Minimal Storage surface so lock logic is testable without a DOM. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type LockRecord = { owner: string; expires: number };

function readLock(store: KeyValueStore, key: string): LockRecord | null {
  try {
    const parsed = JSON.parse(store.getItem(key) || "null");
    if (parsed && typeof parsed.owner === "string" && typeof parsed.expires === "number") return parsed;
  } catch {
    // corrupt lock is treated as free
  }
  return null;
}

/**
 * Best-effort cross-tab lock. Write then read back: if another tab wrote in
 * between, the read-back owner differs and we back off. Expired locks are stolen.
 */
export function tryAcquireLock(store: KeyValueStore, key: string, owner: string, now: number, ttl = IMPORT_LOCK_TTL_MS): boolean {
  const existing = readLock(store, key);
  if (existing && existing.owner !== owner && existing.expires > now) return false;
  try {
    store.setItem(key, JSON.stringify({ owner, expires: now + ttl }));
  } catch {
    return false;
  }
  return readLock(store, key)?.owner === owner;
}

export function releaseLock(store: KeyValueStore, key: string, owner: string) {
  if (readLock(store, key)?.owner === owner) store.removeItem(key);
}

/** Import only once per login: server says not imported and nobody else is running it. */
export function shouldImport(imported: boolean | undefined, alreadyRunning: boolean): boolean {
  return imported === false && !alreadyRunning;
}

export const CARDS_BATCH = 60;

/**
 * normalizeCard always sets `thumb`/`poster`. Cards cached from the raw /api/cards
 * payload (snake_case, no `thumb`) rendered "No image"; treat them as unresolved.
 */
export function isNormalizedCard(card: unknown): card is MovieCard {
  return !!card && typeof (card as MovieCard).thumb === "string" && typeof (card as MovieCard).poster === "string";
}

/** Distinct slugs from `entries` that have no usable card in `cache` and are not already `inflight`. */
export function missingSlugs(entries: readonly SlugEntry[], cache: Readonly<Record<string, MovieCard>>, inflight: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  for (const entry of entries) if (!isNormalizedCard(cache[entry.slug]) && !inflight.has(entry.slug)) out.add(entry.slug);
  return [...out];
}

export function chunk<T>(items: readonly T[], size = CARDS_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `/api/cards` response (raw catalog items) -> normalized cards that carry a slug. */
export function parseCardsResponse(body: unknown): MovieCard[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => !!item && typeof item.slug === "string" && !!item.slug)
    .map((item) => normalizeCard(item));
}
