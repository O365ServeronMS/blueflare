// Dry run of the AI match pass on rows that really lack a tmdb_id. Reads only; nothing is written to the
// database (tmdb_match_ai_runs may not exist yet). Output rows mimic that table: OUT/dryrun-<label>.jsonl.
//   --n 300 --seed 3 --label d1      policy: DEFAULT_AI_POLICY merged with env AI_PROPOSAL (JSON)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { parseGeminiModels } from '../src/geminiRotation.js';
import { createTmdbMatchRotation } from '../src/tmdbMatchGemini.js';
import { exactNameMatch, catalogFacts, decideAiMatch, DEFAULT_AI_POLICY, isAsianRow, matchInput } from '../src/tmdbMatchAi.js';
import { connectReadOnly, INPUT_COLUMNS, jsonlCache, OUT, shuffle, csvCell } from './lib/aiTools.mjs';
import { collectAll, openTmdbClient, rankAll } from './lib/pipeline.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const label = arg('label', 'd1');
const total = Number(arg('n', 300));
const policy = { ...DEFAULT_AI_POLICY, ...(process.env.AI_PROPOSAL ? JSON.parse(process.env.AI_PROPOSAL) : {}) };
const log = (m) => console.log(new Date().toISOString().slice(11, 19) + ' ' + m);

const db = await connectReadOnly();
const { rows } = await db.query(
  `SELECT ${INPUT_COLUMNS} FROM movies WHERE catalog_state='ready' AND tmdb_id IS NULL AND coalesce(tmdb_match_status,'') <> 'verified'`
);
const tableExists = (await db.query("SELECT to_regclass('tmdb_match_ai_runs') AS t")).rows[0].t;
await db.end();
log(`population ${rows.length}; tmdb_match_ai_runs ${tableExists ? 'exists (still not written: read-only run)' : 'missing -> JSONL only'}`);

const cellOf = (row) => { const f = catalogFacts(row); return (f.actorCount >= 2 ? 'cast>=2' : 'cast<2') + ' ' + (isAsianRow(row) ? 'asia' : 'other') + ' ' + f.mediaType; };
const cells = new Map();
for (const row of rows) { const k = cellOf(row); (cells.get(k) ?? cells.set(k, []).get(k)).push(row); }
const alloc = new Map([...cells].map(([k, list]) => [k, Math.max(12, Math.round(total * list.length / rows.length))]));
const sample = [...cells].flatMap(([k, list], i) => shuffle(list, Number(arg('seed', 3)) + i).slice(0, alloc.get(k)));
log(`sample ${sample.length}: ` + [...alloc].map(([k, n]) => `${k}=${n}/${cells.get(k).length}`).join('; '));

const { client: tmdb } = await openTmdbClient();
const collected = await collectAll(sample, tmdb, { onProgress: (d, n) => log(`collect ${d}/${n}`) });
const evidence = sample.map((row) => ({ row, ...collected.get(row.id) }));
let choices = new Map();
if (args.includes('--no-gemini')) {
  // Gemini quota exhausted: stand-in "model" = first pre-ranked candidate whose names match exactly. Proxy only.
  for (const e of evidence) {
    const facts = catalogFacts(matchInput(e.row));
    const pick = e.candidates.find((c) => exactNameMatch(c, facts));
    choices.set(e.row.id, { chosenId: pick ? pick.key : null, confidence: 0.5, reasons: ['stand-in: exact-name candidate'] });
  }
} else {
  const rotations = parseGeminiModels(config.tmdbMatchGeminiModels).map((m) => ({
    model: m.id, call: createTmdbMatchRotation({ ...config, tmdbMatchGeminiModels: m.id + ':' + m.rpm }, { warn: () => {} })
  }));
  assert.ok(rotations.every((r) => r.call));
  const cache = await jsonlCache(OUT + '/gemini-rank-cache.jsonl');
  const ranked = await rankAll(evidence, rotations, { batch: config.tmdbMatchGeminiBatch, cache, log, onProgress: (d, n) => log(`rank ${d}/${n}`) });
  choices = ranked.choices;
  log('gemini ' + JSON.stringify({ ...ranked.stats, latencyMs: undefined }));
}

const runId = randomUUID();
const out = evidence.map((e) => {
  const choice = choices.get(e.row.id);
  const verdict = decideAiMatch({ input: matchInput(e.row), candidates: e.candidates, choice, policy });
  return {
    run_id: runId, mode: 'dry-run', movie_id: e.row.id, cell: cellOf(e.row),
    candidates: e.candidates.map((c) => ({ key: c.key, title: c.title, year: c.year })),
    chosen_tmdb_id: verdict.pick?.id ?? null, media_type: verdict.pick?.type ?? null, confidence: choice?.confidence ?? null,
    evidence: { tier: verdict.tier, reason: verdict.reason, ...verdict.evidence, rivals: undefined },
    status: e.error ? 'error' : verdict.status === 'verified' ? 'chosen' : 'rejected', verdict: verdict.status, tier: verdict.tier, reason: verdict.reason,
    model_answer: choice ?? null, catalog: { title: e.row.title, original_title: e.row.original_title, year: e.row.year }, pick: verdict.pick ? { key: verdict.pick.key, title: verdict.pick.title, year: verdict.pick.year, originalTitle: verdict.pick.originalTitle } : null
  };
});
writeFileSync(OUT + `/dryrun-${label}.jsonl`, out.map((o) => JSON.stringify(o)).join('\n') + '\n');

// per cell acceptance and population extrapolation
const lines = [`# Dry run ${label}: ${out.length} rows, policy ${JSON.stringify(policy)}`, '', '| cell | population | sample | verified | none | unverifiable | est. verified in population |', '|---|---|---|---|---|---|---|'];
let estTotal = 0;
for (const [k, list] of cells) {
  const mine = out.filter((o) => o.cell === k);
  const v = mine.filter((o) => o.verdict === 'verified').length;
  const est = Math.round(list.length * v / Math.max(1, mine.length));
  estTotal += est;
  lines.push(`| ${k} | ${list.length} | ${mine.length} | ${v} | ${mine.filter((o) => o.verdict === 'none').length} | ${mine.filter((o) => o.verdict === 'unverifiable').length} | ${est} |`);
}
lines.push('', `estimated verified over ${rows.length}: ${estTotal} (${(100 * estTotal / rows.length).toFixed(1)}%)`);
const tally = (f) => { const m = {}; for (const o of out) { const k = f(o); m[k] = (m[k] || 0) + 1; } return m; };
lines.push('', 'by tier: ' + JSON.stringify(tally((o) => o.tier ?? '-')), 'reasons: ' + JSON.stringify(tally((o) => o.reason ?? '-')), 'rows with no candidates: ' + out.filter((o) => !o.candidates.length).length);
writeFileSync(OUT + `/dryrun-${label}.md`, lines.join('\n') + '\n');
console.log(lines.join('\n'));

// 40 pairs for manual review: mix of tiers (verified only), plus 15 unverifiable with a pick for contrast
const pickN = (list, n, seed) => shuffle(list, seed).slice(0, n);
const verified = out.filter((o) => o.verdict === 'verified');
const mix = [...pickN(verified.filter((o) => o.tier === 'T1'), 12, 1), ...pickN(verified.filter((o) => o.tier === 'T2'), 22, 2), ...pickN(verified.filter((o) => o.tier === 'T2x'), 6, 3)];
const fill = pickN(verified.filter((o) => !mix.includes(o)), 40 - mix.length, 4);
const review = [...mix, ...fill].slice(0, 40);
const cols = ['catalog_title', 'catalog_original', 'catalog_year', 'tmdb_title', 'tmdb_year', 'tmdb_url', 'tier', 'reason'];
const row2 = (o) => [o.catalog.title, o.catalog.original_title, o.catalog.year, o.pick?.title, o.pick?.year, o.pick ? 'https://www.themoviedb.org/' + o.pick.key.replace(':', '/') : '', o.tier ?? o.verdict, o.tier ? ((o.evidence.overlap != null ? 'cast overlap ' + o.evidence.overlap + '; ' : '') + (o.evidence.name ? 'name "' + o.evidence.name.catalog + '" = "' + o.evidence.name.tmdb + '"; ' : '') + 'year ' + o.evidence.year + '; size ' + o.evidence.size + '; model conf ' + o.confidence) : o.reason];
writeFileSync(OUT + `/dryrun-${label}-review40.csv`, cols.join(',') + '\n' + review.map((o) => row2(o).map(csvCell).join(',')).join('\n') + '\n');
const rej = out.filter((o) => o.verdict !== 'verified' && o.pick);
writeFileSync(OUT + `/dryrun-${label}-rejected-with-pick.csv`, cols.join(',') + '\n' + pickN(rej, 25, 5).map((o) => row2(o).map(csvCell).join(',')).join('\n') + '\n');
