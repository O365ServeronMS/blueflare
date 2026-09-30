import type { MovieCard } from "@/lib/types";

/** Pure helpers behind the guest/account favorites + history store. */

export const LIST_LIMIT = 100;
export const CARD_CACHE_LIMIT = 300;
export const IMPORT_LOCK_TTL_MS = 60_000;

export type StoredMovie = MovieCard & { savedAt: number };
export type SlugEntry = { slug: string; savedAt: number };
export type ImportPayload = { favorites: { slug: string; savedAt: number }[]; history: { slug: string; savedAt: number }[] };

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
export function toSlugEntries(items: readonly { slug?: unknown; savedAt?: unknown }[], limit = LIST_LIMIT): SlugEntry[] {
  const seen = new Set<string>();
  const out: SlugEntry[] = [];
  for (const item of items) {
    if (!item || typeof item.slug !== "string" || !item.slug || seen.has(item.slug)) continue;
    seen.add(item.slug);
    out.push({ slug: item.slug, savedAt: toSavedAtMs(item.savedAt) });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out.slice(0, limit);
}

/** Body for POST /api/me/import built from the guest lists. */
export function buildImportPayload(
  favorites: readonly { slug?: unknown; savedAt?: unknown }[],
  history: readonly { slug?: unknown; savedAt?: unknown }[]
): ImportPayload {
  return { favorites: toSlugEntries(favorites), history: toSlugEntries(history) };
}

/** Server list response -> entries. History rows use `watchedAt`, favorites `savedAt`. */
export function parseServerItems(body: unknown): SlugEntry[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return toSlugEntries(
    items.map((row) => {
      const r = (row || {}) as { slug?: unknown; savedAt?: unknown; watchedAt?: unknown };
      return { slug: r.slug, savedAt: r.savedAt ?? r.watchedAt };
    }),
    500
  );
}

/** Put `slug` at the head of the list (dedup). */
export function pushToHead(list: readonly SlugEntry[], slug: string, now: number, limit = LIST_LIMIT): SlugEntry[] {
  return [{ slug, savedAt: now }, ...list.filter((entry) => entry.slug !== slug)].slice(0, limit);
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
    if (card) out.push({ ...card, savedAt: entry.savedAt });
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

/** Distinct slugs from `entries` that have no card in `cache` and are not already `inflight`. */
export function missingSlugs(entries: readonly SlugEntry[], cache: Readonly<Record<string, MovieCard>>, inflight: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  for (const entry of entries) if (!cache[entry.slug] && !inflight.has(entry.slug)) out.add(entry.slug);
  return [...out];
}

export function chunk<T>(items: readonly T[], size = CARDS_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `/api/cards` response -> usable cards (must carry a string slug). */
export function parseCardsResponse(body: unknown): MovieCard[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is MovieCard => !!item && typeof item.slug === "string" && !!item.slug);
}
