#!/usr/bin/env node
/**
 * Read-only backtest of planDuplicateMerges against the live catalog.
 *   node tools/merge-backtest.mjs [sampleSize]
 */
import { pool } from '../src/db.js';
import { planDuplicateMerges } from '../src/duplicateMerge.js';

const sample = Number(process.argv[2]) || 40;
const COLUMNS = 'm.id, m.canonical_slug, m.title, m.normalized_original_title, m.year, m.media_type, ' +
  'm.tmdb_season_number, m.tmdb_identity_status, m.episode_total, m.episode_current';
const SQL = (having) =>
  'SELECT ' + COLUMNS + ' FROM movies m JOIN movie_provider_sources s ON s.movie_id=m.id ' +
  "WHERE m.catalog_state='ready' GROUP BY m.id HAVING " + having;

const nguonc = (await pool.query(SQL("bool_or(s.provider='nguonc') AND NOT bool_or(s.provider='kkphim')"))).rows;
const kk = (await pool.query(SQL("bool_or(s.provider='kkphim') AND NOT bool_or(s.provider='nguonc')"))).rows;
const { pairs, ambiguous } = planDuplicateMerges(nguonc, kk);
const totals = (p) => [p.keep.episode_total, p.drop.episode_total];
const totalMismatch = pairs.filter((p) => {
  const [a, b] = totals(p).map((v) => Number(String(v || '').match(/\d+/)?.[0]));
  return a && b && a !== b;
});
console.log(JSON.stringify({ nguoncOnly: nguonc.length, kkOnly: kk.length, pairs: pairs.length, ambiguous: ambiguous.length, episodeTotalDiffers: totalMismatch.length }));
const pick = [...pairs].sort(() => Math.random() - 0.5).slice(0, sample);
for (const p of pick) {
  console.log([p.drop.title, '|', p.keep.title, '| s' + p.keep.tmdb_season_number, '|', p.drop.year, '|', p.drop.episode_total, 'vs', p.keep.episode_total].join(' '));
}
console.log('--- episode_total differs (first 15) ---');
for (const p of totalMismatch.slice(0, 15)) console.log([p.drop.canonical_slug, '|', p.keep.canonical_slug, '|', p.drop.episode_total, 'vs', p.keep.episode_total].join(' '));
console.log('--- ambiguous (first 8) ---');
for (const a of ambiguous.slice(0, 8)) console.log(a.drop.canonical_slug, '->', a.candidates.map((c) => c.canonical_slug).join(', '));
await pool.end();
