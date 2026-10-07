// Backtest of "Gemini ranks TMDB candidates, independent gate decides" against provider-supplied tmdb_ids.
//   run    [--per-cell 175] [--limit N] [--seed 1] [--label x]  select sample, collect candidates, rank (network), write evidence
//   report [--label x]                                          replay evidence under every policy variant (offline)
// The pipeline only ever receives matchInput(row); ground truth lives in a separate map.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { config } from '../src/config.js';
import { createTmdbMatchRotation } from '../src/tmdbMatchGemini.js';
import { parseGeminiModels } from '../src/geminiRotation.js';
import { catalogFacts, decideAiMatch, DEFAULT_AI_POLICY, isAsianRow, matchInput, MATCH_INPUT_FIELDS, wilsonLower } from '../src/tmdbMatchAi.js';
import { connectReadOnly, INPUT_COLUMNS, jsonlCache, OUT, shuffle, csvCell } from './lib/aiTools.mjs';
import { entriesHash } from './lib/pipeline.mjs';
import { promptEntry } from '../src/tmdbMatchAi.js';
import { collectAll, openTmdbClient, rankAll } from './lib/pipeline.mjs';

const [mode = 'report', ...rest] = process.argv.slice(2);
const arg = (name, fallback) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : fallback; };
const label = arg('label', 'r1');
const evidenceFile = OUT + '/backtest-evidence-' + arg('evidence', label) + '.jsonl';
const outTag = label + (arg('choice', 'real') === 'real' ? '' : '-' + arg('choice'));

const POLICIES = {
  base: DEFAULT_AI_POLICY,
  v1: { ...DEFAULT_AI_POLICY, t1RequireSize: false, crossTypeNeedsName: false },
  'no-T2x': { ...DEFAULT_AI_POLICY, allowTier2WithCast: false },
  'loose-cast': { ...DEFAULT_AI_POLICY, looseCast: true },
  'tv-end3': { ...DEFAULT_AI_POLICY, tvEndSlack: 3 },
  'whole-names': { ...DEFAULT_AI_POLICY, nameFromSplitPieces: false },
  'name-len5': { ...DEFAULT_AI_POLICY, minNameKeyLength: 5 },
  'proposal': { ...DEFAULT_AI_POLICY, ...(process.env.AI_PROPOSAL ? JSON.parse(process.env.AI_PROPOSAL) : {}) }
};

async function run() {
  const log = (m) => console.log(new Date().toISOString().slice(11, 19) + ' ' + m);
  const client = await connectReadOnly();
  const { rows } = await client.query(
    `SELECT ${INPUT_COLUMNS}, tmdb_id, tmdb_media_type, tmdb_season_number FROM movies WHERE catalog_state='ready' AND tmdb_id IS NOT NULL AND tmdb_media_type IN ('movie','tv')`
  );
  await client.end();
  const truth = new Map();
  const inputs = rows.map((r) => {
    truth.set(r.id, { type: r.tmdb_media_type, id: Number(r.tmdb_id), season: r.tmdb_season_number });
    return matchInput(r);
  });
  for (const input of inputs) for (const key of Object.keys(input)) assert.ok(MATCH_INPUT_FIELDS.includes(key) && !/tmdb|imdb/.test(key));

  const low = [];
  const cells = { 'movie|asia': [], 'movie|other': [], 'tv|asia': [], 'tv|other': [] };
  for (const input of inputs) {
    const facts = catalogFacts(input);
    if (facts.actorCount < 2) low.push(input);
    else cells[facts.mediaType + '|' + (isAsianRow(input) ? 'asia' : 'other')].push(input);
  }
  const perCell = Number(arg('per-cell', 175));
  let sample = [...low, ...Object.values(cells).flatMap((list, i) => shuffle(list, Number(arg('seed', 1)) + i).slice(0, perCell))];
  const limit = Number(arg('limit', 0));
  if (limit) sample = shuffle(sample, 7).slice(0, limit);
  log(`ground truth ${inputs.length}; cast<2 ${low.length}; sample ${sample.length}`);

  const { client: tmdb } = await openTmdbClient();
  const t0 = Date.now();
  const collected = await collectAll(sample, tmdb, { onProgress: (d, n) => log(`collect ${d}/${n} tmdb calls ${tmdb.stats.calls} cached ${tmdb.stats.cached} 429s ${tmdb.stats.retried429}`) });
  log(`collected in ${((Date.now() - t0) / 1000).toFixed(0)}s; tmdb stats ${JSON.stringify(tmdb.stats)}`);
  const evidence = sample.map((row) => ({ row, ...(collected.get(row.id)) }));

  let choices = new Map();
  let stats = { skipped: true };
  if (!rest.includes('--collect-only')) {
    // One rotation per model so a 503 ("high demand") on the best model falls through to the next one.
    const rotations = parseGeminiModels(config.tmdbMatchGeminiModels).map((m) => ({
      model: m.id,
      call: createTmdbMatchRotation({ ...config, tmdbMatchGeminiModels: m.id + ':' + m.rpm }, { warn: (msg) => log(msg.replace(/AIza\S+/g, '[key]')) })
    }));
    assert.ok(rotations.every((r) => r.call), 'rotation unavailable: TMDB_MATCH_GEMINI_API_KEYS missing');
    const cache = await jsonlCache(OUT + '/gemini-rank-cache.jsonl');
    ({ choices, stats } = await rankAll(evidence, rotations, {
      batch: Number(arg('batch', config.tmdbMatchGeminiBatch)), cache, log, parallel: Number(arg('parallel', 3)),
      onProgress: (d, n) => log(`rank ${d}/${n} requests ${cache.size()}`)
    }));
    log('gemini stats ' + JSON.stringify({ ...stats, latencyMs: undefined, p50: median(stats.latencyMs), max: Math.max(0, ...stats.latencyMs) }));
  }
  writeFileSync(evidenceFile, evidence.map((e) => JSON.stringify({
    id: e.row.id, input: e.row, gt: truth.get(e.row.id), queries: e.queries, candidates: e.candidates, error: e.error || null, choice: choices.get(e.row.id) || null
  })).join('\n') + '\n');
  writeFileSync(OUT + '/backtest-run-' + label + '.json', JSON.stringify({ stats: { ...stats, latencyMs: undefined }, tmdb: tmdb.stats, sample: sample.length }, null, 1));
  log('evidence written ' + evidenceFile);
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');

function loadEvidence() {
  const evidence = readFileSync(evidenceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const how = arg('choice', 'real');
  if (how === 'real') {
    // Re-derive the batches exactly as rankAll built them and look the answers up in the Gemini cache file.
    const answers = new Map(readFileSync(OUT + '/gemini-rank-cache.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const withCands = evidence.filter((e) => e.candidates.length);
    for (let i = 0; i < withCands.length; i += Number(arg('batch', 10))) {
      const group = withCands.slice(i, i + Number(arg('batch', 10)));
      const answer = answers.get('rank|' + entriesHash(group.map((e, j) => promptEntry('m' + (j + 1), matchInput(e.input), e.candidates))));
      group.forEach((e, j) => { e.choice = answer?.['m' + (j + 1)] ?? null; });
    }
    return evidence.filter((e) => !e.candidates.length || e.choice);
  }
  // Stand-ins for the model, to measure the gate on its own (no Gemini quota needed).
  for (const e of evidence) {
    const gt = e.candidates.find((c) => c.type === e.gt.type && c.id === e.gt.id);
    const decoy = e.candidates.find((c) => c !== gt);
    const pick = how === 'oracle' ? gt : decoy;
    e.choice = { chosenId: pick ? pick.key : null, confidence: 1, reasons: [how] };
  }
  return evidence;
}

export function score(evidence, policy) {
  return evidence.map((e) => {
    const verdict = decideAiMatch({ input: e.input, candidates: e.candidates, choice: e.choice || undefined, policy });
    const facts = catalogFacts(e.input);
    const gtCand = e.candidates.find((c) => c.type === e.gt.type && c.id === e.gt.id) || null;
    const correct = verdict.pick ? verdict.pick.type === e.gt.type && verdict.pick.id === e.gt.id : null;
    const castBucket = facts.actorCount >= 2 ? 'cast>=2' : 'cast<2';
    return { e, verdict, facts, gtCand, correct, castBucket, region: isAsianRow(e.input) ? 'asia' : 'other', media: facts.mediaType };
  });
}

function table(results, keyFn) {
  const groups = new Map();
  for (const r of results) {
    const key = keyFn(r);
    const g = groups.get(key) ?? { n: 0, verified: 0, correct: 0, gtInCands: 0, modelRight: 0 };
    g.n += 1;
    if (r.gtCand) g.gtInCands += 1;
    if (r.e.choice?.chosenId && r.e.choice.chosenId === r.gtCand?.key) g.modelRight += 1;
    if (r.verdict.status === 'verified') { g.verified += 1; if (r.correct) g.correct += 1; }
    groups.set(key, g);
  }
  return [...groups.entries()].sort().map(([key, g]) =>
    `| ${key} | ${g.n} | ${pct(g.gtInCands, g.n)} | ${pct(g.modelRight, g.n)} | ${g.verified} (${pct(g.verified, g.n)}) | ${g.correct} | ${pct(g.correct, g.verified)} | ${(100 * wilsonLower(g.correct, g.verified)).toFixed(1)}% | ${pct(g.correct, g.n)} |`);
}
const HEAD = '| group | rows | GT in candidates | model right | verified (coverage) | correct | precision | Wilson-low | recall (correct/rows) |\n|---|---|---|---|---|---|---|---|---|';

function report() {
  const evidence = loadEvidence();
  const lines = [`# Backtest ${label}: ${evidence.length} rows`, ''];
  const errors = evidence.filter((e) => e.error).length;
  const noChoice = evidence.filter((e) => e.candidates.length && !e.choice).length;
  lines.push(`TMDB collection errors: ${errors}; rows with candidates but no model answer: ${noChoice}`, '');
  const fpRows = [];
  const missRows = [];
  for (const [name, policy] of Object.entries(POLICIES)) {
    if (name === 'proposal' && !process.env.AI_PROPOSAL) continue;
    const results = score(evidence, policy);
    lines.push(`## policy ${name}`, '', JSON.stringify(policy), '');
    lines.push('### by final tier', '', HEAD, ...table(results, (r) => r.verdict.status === 'verified' ? r.verdict.tier : 'not-verified'), '');
    lines.push('### by cast bucket x region x media (all rows; verified/precision over any tier)', '', HEAD, ...table(results, (r) => [r.castBucket, r.region, r.media].join(' ')), '');
    lines.push('### by tier x region x media', '', HEAD, ...table(results.filter((r) => r.verdict.status === 'verified'), (r) => [r.verdict.tier, r.region, r.media].join(' ')), '');
    const all = results.filter((r) => r.verdict.status === 'verified');
    lines.push(`overall: verified ${all.length}, correct ${all.filter((r) => r.correct).length}, precision ${pct(all.filter((r) => r.correct).length, all.length)}`, '');
    const reasons = new Map();
    for (const r of results) if (r.verdict.status !== 'verified') reasons.set(r.verdict.reason, (reasons.get(r.verdict.reason) || 0) + 1);
    lines.push('not-verified reasons: ' + JSON.stringify(Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1]))), '');
    if (name === 'base' || name === 'proposal') {
      for (const r of results) {
        const base = { policy: name, id: r.e.id, title: r.e.input.title, original: r.e.input.original_title, year: r.e.input.year, media: r.media, region: r.region, cast: r.facts.actorCount };
        if (r.verdict.status === 'verified' && !r.correct) {
          fpRows.push({ ...base, tier: r.verdict.tier, pick: r.verdict.pick.key + ' ' + r.verdict.pick.title + ' (' + r.verdict.pick.year + ')', gt: r.e.gt.type + ':' + r.e.gt.id, gtInCands: r.gtCand ? r.gtCand.title + ' (' + r.gtCand.year + ')' : 'NOT IN CANDIDATES', evidence: JSON.stringify({ ...r.verdict.evidence, rivals: undefined }), reasons: (r.e.choice?.reasons || []).join(' / ') });
        } else if (r.verdict.status !== 'verified' && r.gtCand) {
          missRows.push({ ...base, status: r.verdict.status, reason: r.verdict.reason, model: r.e.choice?.chosenId === r.gtCand.key ? 'chose GT' : r.e.choice?.chosenId ? 'chose ' + r.e.choice.chosenId : 'none', gt: r.gtCand.key + ' ' + r.gtCand.title + ' (' + r.gtCand.year + ')' });
        }
      }
    }
  }
  writeFileSync(OUT + `/backtest-report-${outTag}.md`, lines.join('\n') + '\n');
  const fpCols = ['policy', 'id', 'title', 'original', 'year', 'media', 'region', 'cast', 'tier', 'pick', 'gt', 'gtInCands', 'evidence', 'reasons'];
  writeFileSync(OUT + `/backtest-fp-${outTag}.csv`, fpCols.join(',') + '\n' + fpRows.map((r) => fpCols.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n');
  const missCols = ['policy', 'id', 'title', 'original', 'year', 'media', 'region', 'cast', 'status', 'reason', 'model', 'gt'];
  writeFileSync(OUT + `/backtest-miss-${outTag}.csv`, missCols.join(',') + '\n' + missRows.map((r) => missCols.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`false positives (all policies listed): ${fpRows.length}`);
}

if (mode === 'run') await run();
else if (mode === 'report') report();
