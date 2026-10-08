#!/usr/bin/env node
/**
 * Backtest for the cast-evidence TMDB matcher.
 *
 *   collect   rows JSON on stdin → evidence JSON on stdout. Calls TMDB (read-only)
 *             and needs TMDB_API_KEY. Run it where the worker's env exists.
 *   report    node tools/tmdb-match-backtest.mjs report <evidence.json> [...]
 *             Offline: replays the collected evidence under several policies.
 *
 * A row is { id, original_title, media_type, year, actors, country, truth?, guess? }.
 * `truth` (the verified tmdb_id) makes it a scored row; `guess` (tmdb_lookup_id)
 * lets an unscored row show where the matcher overturns the old title guess.
 */
import { readFileSync } from 'node:fs';
import { mapLimit } from '../src/concurrency.js';
import { collectCandidates, decideMatch, DEFAULT_POLICY } from '../src/tmdbMatch.js';

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

const pct = (value) => (value * 100).toFixed(1) + '%';

export function scorePolicy(rows, policy) {
  let accepted = 0;
  let correct = 0;
  for (const row of rows) {
    const verdict = decideMatch(row.collected.candidates, {
      actorCount: row.collected.actorCount,
      endpoint: row.collected.endpoint,
      year: row.year
    }, policy);
    if (verdict.status !== 'verified') continue;
    accepted += 1;
    if (verdict.pick.id === Number(row.truth)) correct += 1;
  }
  const [low, high] = wilson(correct, accepted);
  return { n: rows.length, accepted, correct, wrong: accepted - correct, precision: accepted ? correct / accepted : 0, low, high, recall: rows.length ? correct / rows.length : 0 };
}

const POLICIES = {
  'overlap>=2 +yearGate (default)': DEFAULT_POLICY,
  'overlap>=2 no yearGate': { ...DEFAULT_POLICY, movieYearGate: false },
  'overlap>=3 +yearGate': { ...DEFAULT_POLICY, minOverlap: 3 },
  'overlap>=2 +yearGate, ties allowed': { ...DEFAULT_POLICY, requireUnique: false },
  'overlap>=1 +yearGate': { ...DEFAULT_POLICY, minOverlap: 1, minCatalogActors: 1 }
};

function printScored(scored) {
  console.log('\n== scored rows (verified tmdb_id known): ' + scored.length + ' ==');
  for (const [name, policy] of Object.entries(POLICIES)) {
    const s = scorePolicy(scored, policy);
    console.log(`${name.padEnd(38)} accepted=${String(s.accepted).padStart(4)} correct=${String(s.correct).padStart(4)} wrong=${String(s.wrong).padStart(3)} precision=${pct(s.precision)} CI95=[${pct(s.low)}, ${pct(s.high)}] recall=${pct(s.recall)}`);
  }
  for (const key of ['endpoint']) {
    for (const value of [...new Set(scored.map((row) => row.collected[key]))]) {
      const s = scorePolicy(scored.filter((row) => row.collected[key] === value), DEFAULT_POLICY);
      console.log(`  default policy, ${value}: n=${s.n} accepted=${s.accepted} precision=${pct(s.precision)} CI95=[${pct(s.low)}, ${pct(s.high)}] recall=${pct(s.recall)}`);
    }
  }
  const byCountry = new Map();
  for (const row of scored) byCountry.set(row.country || '?', [...(byCountry.get(row.country || '?') || []), row]);
  for (const [country, rows] of [...byCountry].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    const s = scorePolicy(rows, DEFAULT_POLICY);
    console.log(`  ${country.padEnd(14)} n=${String(s.n).padStart(4)} accepted=${String(s.accepted).padStart(4)} precision=${pct(s.precision)} recall=${pct(s.recall)}`);
  }
  console.log('\n  wrong picks under the default policy:');
  for (const row of scored) {
    const verdict = decideMatch(row.collected.candidates, { actorCount: row.collected.actorCount, endpoint: row.collected.endpoint, year: row.year }, DEFAULT_POLICY);
    if (verdict.status === 'verified' && verdict.pick.id !== Number(row.truth)) {
      console.log(`   ${row.original_title} (${row.year}) truth=${row.truth} pick=${verdict.pick.id} overlap=${verdict.pick.overlap} votes=${verdict.pick.votes} truthWasCandidate=${row.collected.candidates.some((c) => c.id === Number(row.truth))}`);
    }
  }
}

function printUnscored(unscored) {
  console.log('\n== unverified rows (no ground truth): ' + unscored.length + ' ==');
  const tally = { verified: 0, none: 0, unverifiable: 0 };
  let guessed = 0;
  let agree = 0;
  let overturned = 0;
  const byCountry = new Map();
  for (const row of unscored) {
    const verdict = decideMatch(row.collected.candidates, { actorCount: row.collected.actorCount, endpoint: row.collected.endpoint, year: row.year }, DEFAULT_POLICY);
    tally[verdict.status] += 1;
    const c = byCountry.get(row.country || '?') || { n: 0, verified: 0 };
    c.n += 1;
    if (verdict.status === 'verified') c.verified += 1;
    byCountry.set(row.country || '?', c);
    if (row.guess && verdict.status === 'verified') {
      guessed += 1;
      if (verdict.pick.id === Number(row.guess)) agree += 1; else overturned += 1;
    }
  }
  console.log('  verdicts:', JSON.stringify(tally), ' verified rate', pct(tally.verified / (unscored.length || 1)));
  console.log(`  existing title guess vs cast-verified pick: comparable=${guessed} agree=${agree} overturned=${overturned}` + (guessed ? ` (guess accuracy ≈ ${pct(agree / guessed)})` : ''));
  for (const [country, c] of [...byCountry].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    console.log(`  ${country.padEnd(14)} n=${String(c.n).padStart(4)} verified=${pct(c.verified / c.n)}`);
  }
}

async function collect() {
  const rows = JSON.parse(readFileSync(0, 'utf8'));
  const out = [];
  let done = 0;
  await mapLimit(rows, Number(process.env.BACKTEST_CONCURRENCY) || 4, async (row) => {
    try {
      out.push({ ...row, collected: await collectCandidates(row) });
    } catch (error) {
      out.push({ ...row, collected: null, error: error.message });
    }
    if (++done % 100 === 0) console.error(`collected ${done}/${rows.length}`);
  });
  process.stdout.write(JSON.stringify(out.map((row) => (row.collected ? { ...row, collected: { ...row.collected, bodies: undefined } } : row))));
}

function report(files) {
  const rows = files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')));
  const usable = rows.filter((row) => row.collected);
  console.log(`rows=${rows.length} usable=${usable.length} errors=${rows.length - usable.length}`);
  printScored(usable.filter((row) => row.truth != null));
  printUnscored(usable.filter((row) => row.truth == null));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'collect') await collect();
else if (mode === 'report') report(rest);
else if (process.argv[1]?.endsWith('tmdb-match-backtest.mjs')) {
  console.error('usage: tmdb-match-backtest.mjs collect < rows.json > evidence.json | report evidence.json...');
  process.exit(2);
}
