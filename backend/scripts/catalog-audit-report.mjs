// Read-only CSV of one catalog audit run's actions (default: the latest run).
//   node scripts/catalog-audit-report.mjs <out.csv> [--run <id>] [--status dry-run|applied|blocked|failed|undone]
// Prints the run summary; one CSV line per proposed action with the slugs of the rows involved.
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const out = args.find((a, i) => !a.startsWith('--') && !['--run', '--status'].includes(args[i - 1]));
if (!out) { console.error('usage: catalog-audit-report.mjs <out.csv> [--run <id>] [--status <status>]'); process.exit(2); }
const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query('SET default_transaction_read_only = on');
try {
  const run = (await db.query(
    flag('run') ? 'SELECT * FROM catalog_audit_runs WHERE id=$1' : 'SELECT * FROM catalog_audit_runs ORDER BY id DESC LIMIT 1',
    flag('run') ? [Number(flag('run'))] : [])).rows[0];
  if (!run) { console.error('no catalog audit run'); process.exit(1); }
  console.log(`run ${run.id} mode=${run.mode} status=${run.status} started=${run.started_at.toISOString()} groups=${run.groups}`);
  if (run.summary) console.log(JSON.stringify(run.summary, null, 2));
  const actions = (await db.query(
    'SELECT a.*, (SELECT array_agg(DISTINCT m.canonical_slug) FROM movies m WHERE m.id::text = ANY(ARRAY[' +
    "a.params->>'movieId', a.params->>'keepId', a.params->>'dropId', a.params->>'toMovieId', " +
    "(SELECT s.movie_id::text FROM movie_provider_sources s WHERE s.id::text = a.params->>'sourceId')])) AS rows " +
    'FROM catalog_audit_actions a WHERE a.run_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.id',
    [run.id, flag('status')])).rows;
  const header = ['id', 'group', 'detectors', 'action', 'status', 'gate', 'params', 'reason', 'rows', 'slugs', 'model'];
  const lines = actions.map((a) => [a.id, a.group_key, a.detectors.join(' '), a.action, a.status, a.gate, JSON.stringify(a.params),
    a.reason, (a.rows || []).join(' '), a.slugs.join(' '), a.model].map(cell).join(','));
  writeFileSync(out, [header.join(','), ...lines].join('\n') + '\n');
  console.log(`${actions.length} actions -> ${out}`);
} finally {
  await db.end();
}
