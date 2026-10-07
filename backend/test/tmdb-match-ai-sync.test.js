import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { listAiMatchCandidates, recordAiRun, refreshTmdbAiMatches } from '../src/tmdbMatchAiSync.js';
import { MatchBlockedError, MatchContentError } from '../src/tmdbMatchGemini.js';

const settings = (over = {}) => ({
  tmdbEnabled: true, tmdbApiKey: 'tmdb-test', tmdbMatchAiEnabled: true, tmdbMatchGeminiApiKeys: ['k'],
  tmdbMatchAiMode: 'dry-run', tmdbMatchAiLimit: 100, tmdbMatchAiRetryMs: 1000, tmdbMatchAiErrorRetryMs: 10,
  tmdbMatchGeminiBatch: 2, tmdbMatchConcurrency: 2, ...over
});

const movie = (n, over = {}) => ({
  id: 'id' + n, canonical_slug: 'slug-' + n, title: 'Mây Họa Ánh Trăng', original_title: 'Moonlight Drawn By Clouds', year: 2016,
  media_type: 'tv', countries: [], actors: [], episode_total: '18', duration: '60', ...over
});

// TMDB: one tv show that fits the row above on name + year + size (tier 2).
const detail = { id: 1, name: 'Moonlight Drawn By Clouds', original_name: 'Moonlight Drawn By Clouds', first_air_date: '2016-08-22', number_of_seasons: 1, number_of_episodes: 18, episode_run_time: [60] };
const client = (over = {}) => ({
  get: async (path) => {
    if (over.fail?.(path)) throw new Error('tmdb boom');
    if (path.startsWith('/search/')) return { results: over.empty ? [] : [{ id: 1, name: detail.name, first_air_date: '2016-08-22', vote_count: 5 }] };
    return detail;
  }
});
const pickAll = async () => new Map(Array.from({ length: 10 }, (_, i) => ['m' + i, { chosenId: 'tv:1', confidence: 0.9, reasons: [] }]));

function harness(rows, extra = {}) {
  const runs = [];
  const logs = [];
  const deps = {
    config: settings(extra.config), list: async (args) => { deps.listArgs = args; return rows.slice(0, args.limit); }, record: async (run) => { runs.push(run); },
    client: client(extra.client), rotation: extra.rotation ?? pickAll, state: { blockedUntil: 0 }, log: (m) => logs.push(m), warn: (m) => logs.push(m),
    now: () => 1000, ...extra.deps
  };
  return { deps, runs, logs };
}

test('pass is off when mode off, AI unavailable, or TMDB disabled', async () => {
  for (const config of [{ tmdbMatchAiMode: 'off' }, { tmdbMatchAiEnabled: false }, { tmdbMatchGeminiApiKeys: [] }, { tmdbEnabled: false }, { tmdbApiKey: '' }]) {
    const h = harness([movie(1)], { config });
    assert.deepEqual(await refreshTmdbAiMatches(h.deps), []);
    assert.equal(h.runs.length, 0);
    assert.equal(h.deps.listArgs, undefined, JSON.stringify(config));
  }
});

test('dry-run records runs and never calls assign; limit and batches respected', async () => {
  let assigns = 0;
  const batches = [];
  const rotation = async (req) => { batches.push(req.text.match(/"movieKey"/g).length); return pickAll(); };
  const h = harness([movie(1), movie(2), movie(3), movie(4), movie(5)], { config: { tmdbMatchAiLimit: 3 }, rotation, deps: { assign: async () => { assigns += 1; } } });
  assert.deepEqual(await refreshTmdbAiMatches(h.deps), []);
  assert.equal(assigns, 0);
  assert.equal(h.deps.listArgs.limit, 3);
  assert.deepEqual(batches, [2, 1]);
  assert.equal(h.runs.length, 3);
  assert.ok(h.runs.every((r) => r.mode === 'dry-run' && r.status === 'chosen' && r.outcome === 'verified' && r.chosenTmdbId === 1 && r.mediaType === 'tv'));
  assert.match(h.logs.at(-1), /checked=3 verified=3 .*merged=0 assigned=0/);
});

test('apply calls assign with the exact contract and returns survivor + dropped slugs', async () => {
  const calls = [];
  const results = [
    { action: 'assigned', survivorSlug: 'slug-1' },
    { action: 'merged', survivorSlug: 'kk-2', droppedSlug: 'slug-2' },
    { action: 'conflict', reason: 'taken' }
  ];
  const h = harness([movie(1), movie(2), movie(3)], {
    config: { tmdbMatchAiMode: 'apply' },
    deps: { assign: async (id, identity, opts) => { calls.push({ id, identity, opts }); return results[calls.length - 1]; } }
  });
  assert.deepEqual((await refreshTmdbAiMatches(h.deps)).sort(), ['kk-2', 'slug-1', 'slug-2']);
  assert.deepEqual(calls[0].identity, { tmdbId: 1, mediaType: 'tv', numberOfSeasons: 1 });
  assert.equal(calls[0].opts.source, 'inferred');
  assert.equal(calls[0].opts.evidence.tier, 'T2');
  assert.deepEqual(h.runs.map((r) => r.status), ['applied', 'applied', 'skipped']);
  assert.equal(h.runs[2].evidence.action, 'conflict');
  assert.match(h.logs.at(-1), /merged=1 assigned=1/);
});

test('apply without a usable tmdbIdentity module skips the pass before spending quota', async () => {
  const h = harness([movie(1)], { config: { tmdbMatchAiMode: 'apply' }, deps: { loadIdentity: async () => { throw new Error('missing'); } } });
  let ranked = 0;
  h.deps.rotation = async () => { ranked += 1; return pickAll(); };
  assert.deepEqual(await refreshTmdbAiMatches(h.deps), []);
  assert.equal(ranked, 0);
  assert.equal(h.runs.length, 0);
});

test('assign throwing is isolated to that title', async () => {
  let n = 0;
  const h = harness([movie(1), movie(2)], {
    config: { tmdbMatchAiMode: 'apply' },
    deps: { assign: async () => { n += 1; if (n === 1) throw new Error('db down'); return { action: 'assigned', survivorSlug: 'slug-2' }; } }
  });
  assert.deepEqual(await refreshTmdbAiMatches(h.deps), ['slug-2']);
  assert.deepEqual(h.runs.map((r) => [r.status, r.outcome]), [['error', 'error'], ['applied', 'verified']]);
});

test('blocked rotation stops cleanly: nothing recorded for unranked titles, next cycles wait', async () => {
  let calls = 0;
  const rotation = async () => { calls += 1; throw Object.assign(new MatchBlockedError('gemini: every model is cooling down or exhausted'), { retryAfterMs: 5000 }); };
  const h = harness([movie(1), movie(2), movie(3), movie(4)], { rotation });
  assert.deepEqual(await refreshTmdbAiMatches(h.deps), []);
  assert.equal(calls, 1, 'no further requests after blocked');
  assert.equal(h.runs.length, 0);
  assert.ok(h.logs.some((m) => m === '[worker] tmdb ai match: AI quota exhausted, resuming next cycle'));
  const listed = h.deps.listArgs;
  h.deps.listArgs = undefined;
  await refreshTmdbAiMatches(h.deps);
  assert.equal(h.deps.listArgs, undefined, 'still blocked: no DB or TMDB work');
  assert.ok(listed);
  h.deps.now = () => 1000 + 5001;
  await refreshTmdbAiMatches(h.deps);
  assert.ok(h.deps.listArgs, 'resumes after retryAfter');
});

test('titles without candidates are none without a Gemini call; tmdb failures are error only for that title', async () => {
  let ranked = 0;
  const h = harness([movie(1), movie(2)], { client: { empty: true }, rotation: async () => { ranked += 1; return pickAll(); } });
  await refreshTmdbAiMatches(h.deps);
  assert.equal(ranked, 0);
  assert.deepEqual(h.runs.map((r) => [r.status, r.outcome]), [['rejected', 'none'], ['rejected', 'none']]);

  const f = harness([movie(1), movie(2, { original_title: 'Other Show', title: 'Khac' })], { client: { fail: (p) => p.includes('Other') } });
  await refreshTmdbAiMatches(f.deps);
  assert.deepEqual(f.runs.map((r) => r.outcome).sort(), ['error', 'verified']);
});

test('a content refusal of a batch is isolated per title and does not stop the rest', async () => {
  let n = 0;
  const rotation = async (req) => {
    n += 1;
    if (req.text.includes('Poison') || req.text.match(/"movieKey"/g).length > 1) throw new MatchContentError('refused');
    return pickAll();
  };
  const h = harness([movie(1), movie(2, { original_title: 'Poison', title: 'Poison' })], { rotation, client: { } });
  // both titles share candidate detail, but the prompt of #2 contains its own title
  await refreshTmdbAiMatches(h.deps);
  assert.deepEqual(h.runs.map((r) => [r.movieId, r.outcome]), [['id1', 'verified'], ['id2', 'error']]);
  assert.equal(n, 3);
});

test('listAiMatchCandidates: SQL shape, parameters, ordering and retry rules', async () => {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 'a' }] }; };
  try {
    await listAiMatchCandidates({ mode: 'apply', limit: 7, retryMs: 111, errorRetryMs: 22 });
  } finally { pool.query = original; }
  const { sql, params } = calls[0];
  assert.deepEqual(params, [111, 22, 'apply', 7]);
  assert.match(sql, /tmdb_id IS NULL/);
  assert.match(sql, /tmdb_match_status IS DISTINCT FROM 'verified'/);
  assert.match(sql, /catalog_state='ready'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM tmdb_match_ai_runs/);
  assert.match(sql, /ORDER BY \(jsonb_typeof\(m\.actors\) = 'array' AND jsonb_array_length\(m\.actors\) >= 2\) DESC/);
  assert.equal(Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))), params.length);
  assert.doesNotMatch(sql, /tmdb_id_source|tmdb_match_id/);
});

test('recordAiRun writes one idempotent row with the outcome', async () => {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  try {
    await recordAiRun({ runId: 'r', mode: 'dry-run', movieId: 'm', candidates: [], status: 'rejected', outcome: 'none' });
  } finally { pool.query = original; }
  assert.match(calls[0].sql, /ON CONFLICT \(run_id, movie_id\) DO NOTHING/);
  assert.equal(calls[0].params[8], 'rejected');
  assert.equal(calls[0].params[9], 'none');
});
