// Read-only review report for TMDB identity promotion. Plans every verified tmdb_match_* row the
// worker would promote (nothing is written: the connection is read-only) and exports a random
// sample as CSV for manual review.
//   node scripts/tmdb-identity-report.mjs <out.csv> [--n 200] [--seed 1] [--tmdb] [--limit 100000]
// --tmdb asks TMDB for the season count of series whose season is not evident from the row
// (what the worker does); without it those rows show up as blocked 'season-unknown'.
// The sample is half merges, half plain assignments (all of one kind if the other is short).
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config.js';
import { listPromotionCandidates, needsSeasonCount, planTmdbIdentityWith, tmdbSeasonCount } from '../src/tmdbIdentity.js';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--n' && args[args.indexOf(a) - 1] !== '--seed' && args[args.indexOf(a) - 1] !== '--limit');
const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
if (!out) { console.error('usage: tmdb-identity-report.mjs <out.csv> [--n 200] [--seed 1] [--tmdb] [--limit N]'); process.exit(2); }
const sample = Number(flag('n', 200));
const limit = Number(flag('limit', 100000));
let seed = Number(flag('seed', 1)) >>> 0;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query('SET default_transaction_read_only = on');

const thumb = (row) => row.thumb_asset_id ? `${config.publicBaseUrl}/i/d/${row.thumb_asset_id}.webp` : (row.thumb_source_url || '');
const tmdbUrl = (id, type) => `https://www.themoviedb.org/${type}/${id}`;

const candidates = await listPromotionCandidates(limit, { db });
console.log(`candidates: ${candidates.length}`);

const seasonCounts = new Map();
if (args.includes('--tmdb')) {
  const ids = [...new Set(candidates.filter((r) => needsSeasonCount(r, r.tmdb_match_media_type)).map((r) => Number(r.tmdb_match_id)))];
  console.log(`season counts to fetch: ${ids.length}`);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { seasonCounts.set(id, await tmdbSeasonCount(id)); } catch { seasonCounts.set(id, null); }
    }
  }));
}

const counts = {}; const reasons = {}; const planned = [];
const identityClaims = new Map();
for (const row of candidates) {
  const input = { tmdbId: Number(row.tmdb_match_id), mediaType: row.tmdb_match_media_type, numberOfSeasons: seasonCounts.get(Number(row.tmdb_match_id)) ?? null };
  const plan = await planTmdbIdentityWith(db, row.id, input, { source: 'inferred' });
  counts[plan.action] = (counts[plan.action] || 0) + 1;
  if (plan.reason && (plan.action === 'blocked' || plan.action === 'noop')) reasons[plan.reason] = (reasons[plan.reason] || 0) + 1;
  if (plan.action === 'merge') reasons['merge ' + plan.reason] = (reasons['merge ' + plan.reason] || 0) + 1;
  if (plan.action === 'assign' || plan.action === 'merge') {
    planned.push({ row, input, plan });
    const key = `${input.mediaType}:${input.tmdbId}:${plan.season ?? ''}`;
    identityClaims.set(key, (identityClaims.get(key) || 0) + 1);
  }
}
const mergeGroups = new Set(planned.filter((p) => p.plan.action === 'merge').map((p) => `${p.input.mediaType}:${p.input.tmdbId}:${p.plan.season ?? ''}`));
const collisions = [...identityClaims.values()].filter((n) => n > 1);
console.log('actions', JSON.stringify(counts));
console.log('reasons', JSON.stringify(reasons));
console.log(`merge groups (distinct identities that already have a holder): ${mergeGroups.size}`);
console.log(`identities claimed by 2+ candidates (merge among themselves once the first is assigned): ${collisions.length}, extra rows ${collisions.reduce((a, n) => a + n - 1, 0)}`);

const merges = shuffle(planned.filter((p) => p.plan.action === 'merge'));
const assigns = shuffle(planned.filter((p) => p.plan.action === 'assign'));
const half = Math.ceil(sample / 2);
const pick = [...merges.slice(0, Math.max(half, sample - assigns.length)), ...assigns.slice(0, Math.max(sample - half, sample - merges.length))].slice(0, sample);

// Holder rows are loaded for the picked merges so both sides can be shown.
const header = ['action', 'reason', 'id_source', 'media_type', 'season', 'tmdb_url', 'title', 'year', 'slug', 'thumb_url', 'other_title', 'other_year', 'other_slug', 'other_thumb_url', 'survivor_slug', 'drop_slug'];
const lines = [header.join(',')];
for (const { row, input, plan } of pick) {
  const holder = plan.holder;
  lines.push([
    plan.action, plan.reason || '', holder ? (holder.tmdb_id_source || 'provider') : 'inferred', input.mediaType, plan.season ?? '',
    tmdbUrl(input.tmdbId, input.mediaType), row.title, row.year, row.canonical_slug, thumb(row),
    holder?.title || '', holder?.year || '', holder?.canonical_slug || '', holder ? thumb(holder) : '',
    plan.survivorSlug, plan.dropSlug || ''
  ].map(cell).join(','));
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${pick.length} rows to ${out}`);
await db.end();
