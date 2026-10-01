#!/usr/bin/env node
/**
 * One-off repair: split KKPhim sources that were collapsed into one season-less
 * movie row, by re-ingesting them through the normal season-aware upsert.
 *
 *   node tools/split-kk-seasons.mjs [--apply] [--fetch-only] [--cache-dir DIR]
 *                                   [--limit N] [--invalidate]
 *
 * Default is a dry run: prints metrics and the work list, writes nothing.
 * --fetch-only  download KKPhim detail payloads into --cache-dir, change nothing.
 * --apply       upsertCanonical() every planned source (cached payload, else fetch).
 * --invalidate  after --apply, drop the response keys and Next tags of touched rows.
 *               Never pass it against a scratch database: Valkey is shared.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { normalizeKkphim } from '../src/normalize.js';
import { KkphimProvider } from '../src/providers/KkphimProvider.js';
import { upsertCanonical, getMovieInvalidationDimensions } from '../src/repository.js';
import { invalidateResponseKeys } from '../src/cache.js';
import { revalidateFrontend } from '../src/frontendRevalidation.js';
import { planSeasonSplit } from '../src/seasonSplit.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const apply = flag('--apply');
const fetchOnly = flag('--fetch-only');
const invalidate = flag('--invalidate');
const cacheDir = option('--cache-dir', '/tmp/kk-season-payloads');
const limit = Number(option('--limit', '0')) || Infinity;

const SOURCE_ROWS_SQL =
  "SELECT m.id AS movie_id, m.canonical_slug, m.tmdb_season_number AS row_season, " +
  "s.provider_slug, (s.metadata->>'tmdb_season')::int AS source_season " +
  'FROM movie_provider_sources s JOIN movies m ON m.id=s.movie_id ' +
  "WHERE s.provider='kkphim' AND s.metadata->>'tmdb_type'='tv' AND s.metadata->>'tmdb_season' IS NOT NULL";

async function metrics() {
  const one = async (sql) => Number((await pool.query(sql)).rows[0].n);
  return {
    movies: await one('SELECT count(*) n FROM movies'),
    moviesReady: await one("SELECT count(*) n FROM movies WHERE catalog_state='ready'"),
    kkSources: await one("SELECT count(*) n FROM movie_provider_sources WHERE provider='kkphim'"),
    seasonMismatchSources: await one(
      "SELECT count(*) n FROM movie_provider_sources s JOIN movies m ON m.id=s.movie_id WHERE s.provider='kkphim' " +
      "AND s.metadata->>'tmdb_type'='tv' AND s.metadata->>'tmdb_season' IS NOT NULL " +
      "AND m.tmdb_season_number IS DISTINCT FROM (s.metadata->>'tmdb_season')::int"
    ),
    multiSeasonRows: await one(
      "SELECT count(*) n FROM (SELECT movie_id FROM movie_provider_sources WHERE provider='kkphim' " +
      "AND metadata->>'tmdb_season' IS NOT NULL GROUP BY movie_id HAVING count(DISTINCT metadata->>'tmdb_season')>1) x"
    ),
    rowsWithoutSources: await one(
      'SELECT count(*) n FROM movies m WHERE NOT EXISTS (SELECT 1 FROM movie_provider_sources s WHERE s.movie_id=m.id)'
    ),
    userListRows: await one(
      'SELECT (SELECT count(*) FROM user_favorites) + (SELECT count(*) FROM user_history) n'
    ).catch(() => null)
  };
}

async function payloadFor(provider, slug) {
  const file = path.join(cacheDir, slug.replace(/[^a-z0-9_-]/gi, '_') + '.json');
  try {
    return { payload: JSON.parse(await readFile(file, 'utf8')), cached: true };
  } catch { /* not cached yet */ }
  const response = await provider.detail(slug);
  const payload = { movie: response?.data?.movie ?? response?.movie, episodes: response?.data?.episodes ?? response?.episodes };
  if (!payload.movie) throw new Error('no movie in KKPhim response');
  await writeFile(file, JSON.stringify(payload));
  return { payload, cached: false };
}

const before = await metrics();
console.log('before', JSON.stringify(before));

const plan = planSeasonSplit((await pool.query(SOURCE_ROWS_SQL)).rows).slice(0, limit);
const sourceCount = plan.reduce((sum, group) => sum + group.sources.length, 0);
console.log('plan rows=' + plan.length + ' sources=' + sourceCount);

if (!apply && !fetchOnly) {
  for (const group of plan.slice(0, 10)) {
    console.log('  ' + group.canonicalSlug + ' (season ' + group.rowSeason + ') -> ' +
      group.sources.map((s) => s.slug + '#' + s.season).join(', '));
  }
  console.log('dry run: nothing written');
  await pool.end();
  process.exit(0);
}

await mkdir(cacheDir, { recursive: true });
const provider = new KkphimProvider();
const touched = new Set();
const failures = [];
let done = 0;
for (const group of plan) {
  touched.add(group.canonicalSlug);
  for (const source of group.sources) {
    try {
      const { payload } = await payloadFor(provider, source.slug);
      if (apply) {
        const { movie } = await upsertCanonical(normalizeKkphim(payload));
        touched.add(movie.canonical_slug);
      }
    } catch (error) {
      failures.push({ slug: source.slug, error: error.message });
      console.warn('FAIL ' + source.slug + ': ' + error.message);
    }
    done += 1;
    if (done % 100 === 0) console.log('progress ' + done + '/' + sourceCount);
  }
}

console.log('done sources=' + done + ' failures=' + failures.length);
if (failures.length) await writeFile(path.join(cacheDir, 'failures.json'), JSON.stringify(failures, null, 1));

if (apply) {
  console.log('after', JSON.stringify(await metrics()));
  if (invalidate) {
    const slugs = [...touched];
    const movies = await getMovieInvalidationDimensions(slugs);
    const keys = ['home'];
    const tags = ['home', 'list'];
    for (const type of config.invalidateListTypes) {
      tags.push('list:' + type);
      for (let page = 1; page <= config.invalidatePageDepth; page += 1) keys.push('list:' + type + ':' + page);
    }
    for (let page = 1; page <= config.invalidatePageDepth; page += 1) tags.push('page:' + page);
    for (const slug of slugs) {
      keys.push('movie:' + slug, 'recommendations:' + slug);
      tags.push('movie:' + slug);
    }
    for (const movie of movies) {
      for (const [field, keyPrefix, tagPrefix] of [[movie.genres, 'genre:', 'category:'], [movie.countries, 'country:', 'country:']]) {
        for (const item of Array.isArray(field) ? field : []) {
          const slug = String(item?.slug || '').trim().toLowerCase();
          if (!slug) continue;
          tags.push(tagPrefix + slug);
          for (let page = 1; page <= config.invalidatePageDepth; page += 1) keys.push(keyPrefix + slug + ':' + page);
        }
      }
    }
    const deleted = await invalidateResponseKeys(keys);
    const stats = await revalidateFrontend([...new Set(tags)]);
    console.log('invalidated touched=' + slugs.length + ' keysDeleted=' + deleted + ' ' + JSON.stringify(stats));
  }
}
await pool.end();
