#!/usr/bin/env node
/**
 * Read-only backtest of the duplicate-merge planner against the live catalog.
 *   node tools/merge-backtest.mjs [sampleSize]
 */
import { pool } from '../src/db.js';
import { planCatalogMerges } from '../src/duplicateMergeRepository.js';

const sample = Number(process.argv[2]) || 30;
const { pairs, ambiguous } = await planCatalogMerges();
const byEvidence = {};
for (const pair of pairs) byEvidence[pair.evidence] = (byEvidence[pair.evidence] || 0) + 1;
console.log(JSON.stringify({ pairs: pairs.length, ambiguous: ambiguous.length, byEvidence, renames: pairs.filter((p) => p.renameTo).length }));
for (const pair of [...pairs].sort(() => Math.random() - 0.5).slice(0, sample)) {
  console.log([pair.evidence, pair.drop.canonical_slug, '=>', pair.keep.canonical_slug, pair.renameTo ? '(rename ' + pair.renameTo + ')' : '', 's' + pair.keep.tmdb_season_number, pair.drop.episode_total + 'vs' + pair.keep.episode_total].join(' '));
}
for (const a of ambiguous.slice(0, 8)) console.log('ambiguous', a.drop.canonical_slug, '->', a.candidates.map((c) => c.canonical_slug).join(', '));
await pool.end();
