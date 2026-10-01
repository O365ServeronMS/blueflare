#!/usr/bin/env node
/**
 * One-off / manual runner for the worker's duplicate merge.
 *   node tools/merge-duplicates.mjs [--apply] [--limit N]
 * Default prints the plan size only. Never invalidates caches: run it against a
 * scratch database, or let the worker's dry-run/apply mode own production.
 */
import { migrate, pool } from '../src/db.js';
import { mergeDuplicate, planCatalogMerges } from '../src/duplicateMergeRepository.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limit = Number(args[args.indexOf('--limit') + 1]) || Infinity;

if (apply) await migrate();
const { pairs, ambiguous } = await planCatalogMerges();
console.log(JSON.stringify({ pairs: pairs.length, ambiguous: ambiguous.length }));
if (apply) {
  let merged = 0;
  const skipped = [];
  for (const pair of pairs.slice(0, limit)) {
    const result = await mergeDuplicate(pair.keep.id, pair.drop.id);
    if (result.merged) merged += 1; else skipped.push(result.reason);
  }
  console.log(JSON.stringify({ merged, skipped: skipped.length }));
}
await pool.end();
