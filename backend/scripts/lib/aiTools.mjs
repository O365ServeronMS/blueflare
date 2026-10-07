import { createReadStream, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { config } from '../../src/config.js';

export const OUT = process.env.AI_OUT_DIR || '/out';

/** Read-only PostgreSQL session: every statement in it fails if it tries to write. */
export async function connectReadOnly() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  return client;
}

/** Columns the matcher may see (never tmdb_id / imdb_id / tmdb_match_*). */
export const INPUT_COLUMNS = 'id, title, original_title, year, media_type, display_type, countries, actors, episode_total, duration, overview';

/** Append-only JSONL key/value cache, so a replay under another rule does not hit TMDB or Gemini again. */
export async function jsonlCache(file) {
  const map = new Map();
  if (existsSync(file)) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { const [k, v] = JSON.parse(line); map.set(k, v); } catch { /* torn last line */ }
    }
  }
  return {
    size: () => map.size,
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); appendFileSync(file, JSON.stringify([key, value]) + '\n'); }
  };
}

/** fetch wrapper that turns a TMDB 429 into an error carrying Retry-After. */
export function tmdbFetch() {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw Object.assign(new Error('TMDB returned HTTP 429'), { status: 429, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000 });
    }
    return response;
  };
}

export const tmdbOptions = () => ({ apiKey: config.tmdbApiKey, baseUrl: config.tmdbBaseUrl, timeoutMs: 15000, fetchImpl: tmdbFetch() });

export function shuffle(list, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; await fn(items[i], i); }
  }));
}

export const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
