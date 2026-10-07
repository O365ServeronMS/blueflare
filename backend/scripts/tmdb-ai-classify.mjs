// Read-only breakdown of the catalog rows that still have no tmdb_id and no verified match.
import { writeFileSync } from 'node:fs';
import { connectReadOnly, OUT, INPUT_COLUMNS } from './lib/aiTools.mjs';
import { catalogFacts, isAsianRow, isLatinName } from '../src/tmdbMatchAi.js';

export function popFlags(row) {
  const facts = catalogFacts(row);
  const hay = (row.original_title || '') + ' | ' + (row.title || '');
  const sportsVs = /\b(vs\.?|v)\b/i.test(hay) && /\b(FC|Club|United|City|Madrid|Barcelona|Am[eé]rica|Cup|League|Liga|Copa|Final|Semi|Quarter|Match|Highlights|Round|Grand Prix|UFC|WWE|NBA|NFL|MLS)\b/i.test(hay);
  const clip = /\b(highlights?|full match|live stream|livestream|fancam|teaser|behind the scenes|making of|press conference|concert|stand-?up special|recap)\b/i.test(hay);
  const hasName = facts.names.some((n) => n.source === 'original');
  return {
    cast: facts.actorCount >= 2 ? '2+' : String(facts.actorCount),
    asian: isAsianRow(row) ? 'asia' : 'other',
    media: facts.mediaType,
    year: facts.year ? 'year' : 'noyear',
    name: !hasName ? 'no-original' : facts.names.some((n) => n.source === 'original' && n.latin) ? 'latin' : 'cjk-only',
    sportsVs, clip
  };
}

const client = await connectReadOnly();
const { rows } = await client.query(
  `SELECT ${INPUT_COLUMNS} FROM movies WHERE catalog_state='ready' AND tmdb_id IS NULL AND coalesce(tmdb_match_status,'') <> 'verified'`
);
await client.end();
const strata = new Map();
const flagCounts = { sportsVs: 0, clip: 0, noOriginal: 0, noYear: 0 };
for (const row of rows) {
  const f = popFlags(row);
  const key = [f.cast, f.asian, f.media, f.year, f.name].join(' | ');
  strata.set(key, (strata.get(key) || 0) + 1);
  if (f.sportsVs) flagCounts.sportsVs += 1;
  if (f.clip) flagCounts.clip += 1;
  if (f.name === 'no-original') flagCounts.noOriginal += 1;
  if (f.year === 'noyear') flagCounts.noYear += 1;
}
const table = [...strata.entries()].sort((a, b) => b[1] - a[1]);
const marg = (idx) => { const m = new Map(); for (const [k, n] of table) { const v = k.split(' | ')[idx]; m.set(v, (m.get(v) || 0) + n); } return Object.fromEntries(m); };
const report = { total: rows.length, byCast: marg(0), byRegion: marg(1), byMedia: marg(2), byYear: marg(3), byName: marg(4), flagCounts, strata: table };
writeFileSync(OUT + '/classify.json', JSON.stringify(report, null, 1));
writeFileSync(OUT + '/classify-strata.csv', 'cast,region,media,year,name,count\n' + table.map(([k, n]) => k.split(' | ').join(',') + ',' + n).join('\n') + '\n');
console.log(JSON.stringify({ ...report, strata: undefined }, null, 1));
console.log(table.slice(0, 40).map(([k, n]) => String(n).padStart(6) + '  ' + k).join('\n'));
