// Offline check of the deterministic gate against past AI match runs. Reads the database (read-only
// session) and TMDB; no model call, no database write.
//   node scripts/tmdb-match-det-backtest.mjs [--limit 1000] [--status applied|none] [--seed ...]
// CSV on stdout: movie_id,slug,ai_key,passers,det_key,same ; the summary goes to stderr.
import { collectAiCandidates, createTmdbClient, gatePassers, matchInput } from '../src/tmdbMatchAi.js';
import { config } from '../src/config.js';
import { connectReadOnly, csvCell, INPUT_COLUMNS, tmdbOptions } from './lib/aiTools.mjs';

const HELP = `Usage: node scripts/tmdb-match-det-backtest.mjs [--limit 1000] [--status applied|none]

Samples random rows of tmdb_match_ai_runs, rebuilds their TMDB candidates (collectAiCandidates) and
computes gatePassers. Never calls a model and never writes to the database.
  --status applied  runs with status 'applied' (ai_key = the id the model chose and the gate verified)
  --status none     runs where the model answered none (evidence.reason = 'model-chose-none')
  --limit N         sample size (default 1000)
Output: CSV movie_id,slug,ai_key,passers,det_key,same on stdout; totals on stderr.
TMDB calls use the shared client (concurrency ${Math.min(4, config.tmdbMatchConcurrency ?? 2)}, Retry-After and backoff on 429).`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const limit = Math.max(1, Math.floor(Number(arg('limit', 1000))) || 1000);
const status = arg('status', 'applied');
if (!['applied', 'none'].includes(status)) { console.error('--status must be applied or none'); process.exit(2); }
if (!config.tmdbApiKey) { console.error('TMDB_API_KEY is not set'); process.exit(2); }

const filter = status === 'applied'
  ? "r.status = 'applied' AND r.chosen_tmdb_id IS NOT NULL"
  : "r.evidence->>'reason' = 'model-chose-none'";
const db = await connectReadOnly();
const { rows } = await db.query(
  `SELECT DISTINCT ON (r.movie_id) r.movie_id, r.media_type AS ai_type, r.chosen_tmdb_id, m.canonical_slug AS slug,
          ${INPUT_COLUMNS.split(', ').map((c) => 'm.' + c).join(', ')}
     FROM tmdb_match_ai_runs r JOIN movies m ON m.id = r.movie_id
    WHERE ${filter}
    ORDER BY r.movie_id, r.created_at DESC`
);
await db.end();
// random sample without replacement
for (let i = rows.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
const sample = rows.slice(0, limit);

const client = createTmdbClient({ tmdb: tmdbOptions(), concurrency: config.tmdbMatchConcurrency ?? 2 });
const total = { rows: 0, errors: 0, one: 0, same: 0, zero: 0, many: 0 };
console.log('movie_id,slug,ai_key,passers,det_key,same');
let next = 0;
const worker = async () => {
  for (;;) {
    const row = sample[next++];
    if (!row) return;
    let passers;
    try {
      const { candidates } = await collectAiCandidates(matchInput(row), client);
      passers = gatePassers({ input: matchInput(row), candidates });
    } catch (error) {
      total.errors += 1;
      console.error('skip ' + row.slug + ': ' + String(error.message).slice(0, 120));
      continue;
    }
    const aiKey = status === 'applied' ? row.ai_type + ':' + row.chosen_tmdb_id : '';
    const detKey = passers.length === 1 ? passers[0].key : '';
    total.rows += 1;
    if (passers.length === 0) total.zero += 1; else if (passers.length === 1) total.one += 1; else total.many += 1;
    const same = status === 'applied' && passers.length === 1 ? detKey === aiKey : '';
    if (same === true) total.same += 1;
    console.log([row.movie_id, row.slug, aiKey, passers.length, detKey, same].map(csvCell).join(','));
  }
};
await Promise.all(Array.from({ length: Math.min(4, config.tmdbMatchConcurrency ?? 2) }, worker));

const pct = (a, b) => (b ? (100 * a / b).toFixed(2) + '%' : 'n/a');
console.error(`status=${status} sampled=${total.rows} tmdb_errors=${total.errors} passers 0/1/2+ = ${total.zero}/${total.one}/${total.many}`);
console.error(`exactly one passer: ${total.one}/${total.rows} (${pct(total.one, total.rows)})`);
if (status === 'applied') console.error(`of those, det_key === ai_key: ${total.same}/${total.one} (${pct(total.same, total.one)})`);
console.error('tmdb ' + JSON.stringify(client.stats));
