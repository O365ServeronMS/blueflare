// Read-only report of the provider TMDB/IMDb id pass (provider_identity_reviews, written by
// src/providerIdentitySync.js). Prints counts by status/action/tier/reason and exports the rows
// as CSV for review before a tier is enabled (nothing is written: the connection is read-only).
//   node scripts/provider-identity-report.mjs <out.csv> [--status planned] [--tier overwrite] [--reason providers-disagree] [--limit 100000]
// Outcome column: would-assign / would-merge:<slug> (dry-run or tier off), assigned / merged,
// a planner refusal (pinned, guard reasons, holder-pinned …), and imdb-filled / imdb-conflict.
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const valued = new Set(['--status', '--tier', '--reason', '--limit']);
const out = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const flag = (name, fallback = null) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
if (!out) {
  console.error('usage: provider-identity-report.mjs <out.csv> [--status S] [--tier T] [--reason R] [--limit N]');
  process.exit(2);
}
const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const tmdbUrl = (c) => (c?.id && c?.type ? `https://www.themoviedb.org/${c.type}/${c.id}` : '');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query('SET default_transaction_read_only = on');

const summary = await db.query(
  'SELECT status, action, tier, reason, count(*)::int AS n FROM provider_identity_reviews GROUP BY 1,2,3,4 ORDER BY 1,2,3,5 DESC'
);
console.log('status\taction\ttier\treason\tcount');
for (const r of summary.rows) console.log([r.status, r.action, r.tier ?? '-', r.reason ?? '-', r.n].join('\t'));

const filters = [];
const values = [];
for (const [name, column] of [['status', 'r.status'], ['tier', 'r.tier'], ['reason', 'r.reason']]) {
  const value = flag(name);
  if (value) { values.push(value); filters.push(`${column}=$${values.length}`); }
}
values.push(Math.max(1, Number(flag('limit', 100000))));
const rows = (await db.query(
  'SELECT r.*, m.canonical_slug, m.title, m.original_title, m.year, m.display_type, m.tmdb_id, m.tmdb_media_type, ' +
  'm.tmdb_season_number, m.tmdb_id_source, m.imdb_id, m.tmdb_identity_pinned FROM provider_identity_reviews r ' +
  'JOIN movies m ON m.id=r.movie_id ' + (filters.length ? 'WHERE ' + filters.join(' AND ') + ' ' : '') +
  `ORDER BY r.status, r.action, r.tier NULLS LAST, r.reason, m.canonical_slug LIMIT $${values.length}`,
  values
)).rows;
await db.end();

const header = ['status', 'action', 'tier', 'reason', 'outcome', 'slug', 'title', 'original_title', 'year', 'display_type',
  'row_tmdb', 'row_source', 'row_imdb', 'pinned', 'claims', 'candidates', 'row_tmdb_url', 'candidate_urls', 'decided_at', 'movie_id'];
const lines = [header.join(',')];
for (const r of rows) {
  const claims = (r.claims || []).map((c) => [c.provider, c.tmdbId ? `${c.mediaType}:${c.tmdbId}${c.season ? ':s' + c.season : ''}` : '-', c.imdbId || '-'].join(' ')).join(' | ');
  const candidates = (r.candidates || []).map((c) => `${c.type}:${c.id}`).join(' | ');
  const rowTmdb = r.tmdb_id ? `${r.tmdb_media_type}:${r.tmdb_id}${r.tmdb_season_number ? ':s' + r.tmdb_season_number : ''}` : '';
  lines.push([
    r.status, r.action, r.tier, r.reason, r.outcome, r.canonical_slug, r.title, r.original_title, r.year, r.display_type,
    rowTmdb, r.tmdb_id_source, r.imdb_id, r.tmdb_identity_pinned ? 'yes' : '', claims, candidates,
    tmdbUrl({ id: r.tmdb_id, type: r.tmdb_media_type }), (r.candidates || []).map(tmdbUrl).join(' '),
    r.decided_at?.toISOString?.() ?? r.decided_at, r.movie_id
  ].map(cell).join(','));
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${rows.length} rows to ${out}`);
