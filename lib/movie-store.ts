import type { MovieCard } from "@/lib/types";
import { CATALOG_BASE } from "@/lib/catalog";
import {
  buildImportPayload,
  chunk,
  missingSlugs,
  parseCardsResponse,
  parseServerItems,
  pushToHead,
  removeSlug,
  resolveCards,
  runOptimistic,
  releaseLock,
  shouldImport,
  tryAcquireLock,
  upsertCard,
  LIST_LIMIT,
  type SlugEntry,
  type StoredMovie,
} from "@/lib/movie-sync";

/**
 * Browser-only favorites/history store with two backends behind one API.
 * Guests use localStorage exactly as before. Logged-in users use /api/me/*;
 * their server lists live only in memory (never in the guest keys), so logging
 * out cannot leak them. The server returns only slugs, so card data comes from
 * a local slug->card cache filled whenever a movie is saved or watched.
 */

export type ListKey = "favorites" | "history";
export type StoreMode = "loading" | "guest" | "user";

const KEYS: Record<ListKey, { key: string; legacy: string }> = {
  favorites: { key: "film.bluesia.net:favorites", legacy: "bluesia:favorites" },
  history: { key: "film.bluesia.net:history", legacy: "bluesia:history" },
};
const CARDS_KEY = "film.bluesia.net:cards";
const IMPORT_LOCK_KEY = "film.bluesia.net:import-lock";
const UPDATED_EVENT = "film.bluesia.net:local-movies-updated";
const LEGACY_UPDATED_EVENT = "bluesia:local-movies-updated";

let mode: StoreMode = "loading";
let server: Record<ListKey, SlugEntry[]> = { favorites: [], history: [] };
let started: Promise<void> | null = null;
let importing = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function readGuestList(list: ListKey): StoredMovie[] {
  if (typeof window === "undefined") return [];
  const { key, legacy } = KEYS[list];
  const current = readJson<StoredMovie[]>(key, []);
  return current.length ? current : readJson<StoredMovie[]>(legacy, []);
}

export function writeGuestList(list: ListKey, movies: StoredMovie[]) {
  localStorage.setItem(KEYS[list].key, JSON.stringify(movies.slice(0, LIST_LIMIT)));
  window.dispatchEvent(new Event(UPDATED_EVENT));
  window.dispatchEvent(new Event(LEGACY_UPDATED_EVENT));
}

function readCards(): Record<string, MovieCard> {
  return readJson<Record<string, MovieCard>>(CARDS_KEY, {});
}

function rememberCards(cards: readonly MovieCard[]) {
  if (!cards.length) return;
  try {
    let cache = readCards();
    for (const card of cards) if (card?.slug) cache = upsertCard(cache, card);
    localStorage.setItem(CARDS_KEY, JSON.stringify(cache));
  } catch {
    // storage full or blocked: cards just will not resolve later
  }
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const resolving = new Set<string>();

/**
 * Fill the card cache for server slugs with no local card via the public
 * /api/cards endpoint (<=60 per call). Anonymous request: no cookies. Failures
 * leave slugs hidden; the next refresh retries because nothing is recorded.
 */
async function resolveMissingCards(): Promise<void> {
  const wanted = missingSlugs([...server.favorites, ...server.history], readCards(), resolving);
  if (!wanted.length) return;
  wanted.forEach((slug) => resolving.add(slug));
  await Promise.all(
    chunk(wanted).map(async (batch) => {
      try {
        const res = await fetch(`${CATALOG_BASE}/api/cards?slugs=${batch.map(encodeURIComponent).join(",")}`, {
          credentials: "omit",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        const cards = parseCardsResponse(await res.json().catch(() => null));
        if (cards.length) {
          rememberCards(cards);
          emit();
        }
      } catch {
        // network failure: slugs stay hidden until the next refresh
      } finally {
        batch.forEach((slug) => resolving.delete(slug));
      }
    })
  );
}

function toGuest() {
  mode = "guest";
  server = { favorites: [], history: [] };
  emit();
}

async function runImport(): Promise<void> {
  importing = true;
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    if (!tryAcquireLock(localStorage, IMPORT_LOCK_KEY, owner, Date.now())) return;
    const favorites = readGuestList("favorites");
    const history = readGuestList("history");
    rememberCards([...favorites, ...history]);
    const res = await api("POST", "/api/me/import", buildImportPayload(favorites, history));
    if (!res.ok) return; // keep guest data; retried on the next refresh
    for (const list of ["favorites", "history"] as const) {
      localStorage.removeItem(KEYS[list].key);
      localStorage.removeItem(KEYS[list].legacy);
    }
    window.dispatchEvent(new Event(UPDATED_EVENT));
  } catch {
    // network failure: guest data stays untouched
  } finally {
    releaseLock(localStorage, IMPORT_LOCK_KEY, owner);
    importing = false;
  }
}

async function fetchList(list: ListKey): Promise<SlugEntry[] | null> {
  const res = await api("GET", `/api/me/${list}`);
  if (!res.ok) return null;
  return parseServerItems(await res.json().catch(() => null));
}

async function refresh(): Promise<void> {
  try {
    const res = await api("GET", "/api/me");
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!body?.user) return toGuest();
    if (shouldImport(body.imported, importing)) await runImport();
    const [favorites, history] = await Promise.all([fetchList("favorites"), fetchList("history")]);
    server = { favorites: favorites ?? server.favorites, history: history ?? server.history };
    mode = "user";
    emit();
    void resolveMissingCards();
  } catch {
    if (mode === "loading") toGuest();
  }
}

function start(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!started) {
    started = refresh();
    window.addEventListener("focus", () => void refresh());
  }
  return started;
}

export function refreshAccountStore() {
  return refresh();
}

export function subscribeMovieStore(onChange: () => void) {
  void start();
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener(UPDATED_EVENT, onChange);
  window.addEventListener(LEGACY_UPDATED_EVENT, onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener(UPDATED_EVENT, onChange);
    window.removeEventListener(LEGACY_UPDATED_EVENT, onChange);
  };
}

export const SERVER_SNAPSHOT = "loading|[]";

/** Stable string snapshot `<mode>|<json items>` for useSyncExternalStore. */
export function getSnapshot(list: ListKey): string {
  const items = mode === "user" ? resolveCards(server[list], readCards()) : readGuestList(list);
  return `${mode}|${JSON.stringify(items)}`;
}

export function parseSnapshot(snapshot: string): { mode: StoreMode; items: StoredMovie[] } {
  const cut = snapshot.indexOf("|");
  return { mode: snapshot.slice(0, cut) as StoreMode, items: JSON.parse(snapshot.slice(cut + 1)) };
}

function optimisticServerWrite(list: ListKey, next: SlugEntry[], request: () => Promise<boolean>) {
  const previous = server[list];
  return runOptimistic({
    previous,
    next,
    apply: (value) => {
      server = { ...server, [list]: value };
      emit();
    },
    request,
    isCurrent: () => server[list] === next,
  });
}

export async function toggleFavorite(movie: MovieCard): Promise<void> {
  if (typeof window === "undefined") return;
  await start();
  if (mode === "user") {
    const has = server.favorites.some((entry) => entry.slug === movie.slug);
    rememberCards([movie]);
    const slug = encodeURIComponent(movie.slug);
    await optimisticServerWrite(
      "favorites",
      has ? removeSlug(server.favorites, movie.slug) : pushToHead(server.favorites, movie.slug, Date.now(), 500),
      async () => (await api(has ? "DELETE" : "PUT", `/api/me/favorites/${slug}`)).ok
    );
    return;
  }
  const current = readGuestList("favorites");
  writeGuestList(
    "favorites",
    current.some((item) => item.slug === movie.slug)
      ? current.filter((item) => item.slug !== movie.slug)
      : [{ ...movie, savedAt: Date.now() }, ...current]
  );
}

export async function recordHistory(movie: MovieCard): Promise<void> {
  if (typeof window === "undefined") return;
  await start();
  if (mode === "user") {
    rememberCards([movie]);
    await optimisticServerWrite(
      "history",
      pushToHead(server.history, movie.slug, Date.now()),
      async () => (await api("PUT", `/api/me/history/${encodeURIComponent(movie.slug)}`)).ok
    );
    return;
  }
  const current = readGuestList("history").filter((item) => item.slug !== movie.slug);
  writeGuestList("history", [{ ...movie, savedAt: Date.now() }, ...current]);
}

/** Replace a whole list (guest) or delete the removed slugs (account). */
export async function replaceList(list: ListKey, next: StoredMovie[]): Promise<void> {
  await start();
  if (mode !== "user") return writeGuestList(list, next);
  const keep = new Set(next.map((item) => item.slug));
  for (const entry of server[list]) {
    if (!keep.has(entry.slug)) {
      const slug = encodeURIComponent(entry.slug);
      const path = list === "favorites" ? `/api/me/favorites/${slug}` : `/api/me/history/${slug}`;
      await optimisticServerWrite(list, removeSlug(server[list], entry.slug), async () => (await api("DELETE", path)).ok);
    }
  }
}
