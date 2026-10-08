import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { listAiMatchCandidates, recordAiRun, refreshTmdbAiMatches } from '../src/tmdbMatchAiSync.js';
import { MatchBlockedError, MatchContentError } from '../src/tmdbMatchRotation.js';

const settings = (over = {}) => ({
  tmdbEnabled: true, tmdbApiKey: 'tmdb-test', tmdbMatchAiEnabled: true, openrouterApiKeys: ['k'],
  tmdbMatchAiMode: 'dry-run', tmdbMatchAiLimit: 100, tmdbMatchAiRetryMs: 1000, tmdbMatchAiErrorRetryMs: 10,
  tmdbMatchAiBatchMax: 2, tmdbMatchConcurrency: 2, ...over
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
  for (const config of [{ tmdbMatchAiMode: 'off' }, { tmdbMatchAiEnabled: false }, { openrouterApiKeys: [] }, { tmdbEnabled: false }, { tmdbApiKey: '' }]) {
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
  const rotation = async () => { calls += 1; throw Object.assign(new MatchBlockedError('openrouter: every model is cooling down or exhausted'), { retryAfterMs: 5000 }); };
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

test('titles without candidates are none without an AI call; tmdb failures are error only for that title', async () => {
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

// ---- token-budget packing, calibration, bisection, thinking ----------------------------------

const manyChoices = async () => new Map(Array.from({ length: 80 }, (_, i) => ['m' + i, { chosenId: 'tv:1', confidence: 0.9, reasons: [] }]));
const countKeys = (req) => req.text.match(/"movieKey"/g).length;
const cast = ['Aa Bb', 'Cc Dd', 'Ee Ff'];

/** Prompt chars one film adds, measured through the engine itself (a pack of one). */
async function filmChars() {
  const seen = [];
  const h = harness([movie(1)], { config: { tmdbMatchAiBatchMax: 1 }, rotation: async (req) => { seen.push(req.text.length); return manyChoices(); } });
  await refreshTmdbAiMatches(h.deps);
  const { RANK_PROMPT_OVERHEAD_CHARS } = await import('../src/tmdbMatchAi.js');
  return seen[0] - RANK_PROMPT_OVERHEAD_CHARS;
}

test('packing: films are added until the estimated token budget is full', async () => {
  const e = await filmChars();
  const budget = Math.ceil((((await import('../src/tmdbMatchAi.js')).RANK_PROMPT_OVERHEAD_CHARS) + 2.5 * e) / 3); // room for 2, not 3
  const sizes = [];
  const h = harness(Array.from({ length: 5 }, (_, i) => movie(i + 1)), {
    config: { tmdbMatchAiBatchTokens: budget, tmdbMatchAiBatchMax: 40 },
    rotation: async (req) => { sizes.push(countKeys(req)); assert.ok(req.tokens <= budget, 'estimate stays inside the budget'); return manyChoices(); }
  });
  await refreshTmdbAiMatches(h.deps);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(h.runs.length, 5);
});

test('packing: the film-count limit applies even when tokens would allow more', async () => {
  const sizes = [];
  const h = harness(Array.from({ length: 7 }, (_, i) => movie(i + 1)), {
    config: { tmdbMatchAiBatchTokens: 1e9, tmdbMatchAiBatchMax: 3 },
    rotation: async (req) => { sizes.push(countKeys(req)); return manyChoices(); }
  });
  await refreshTmdbAiMatches(h.deps);
  assert.deepEqual(sizes, [3, 3, 1]);
});

test('packing: a film alone is never split off by the budget; tiers (cast / no cast) never share a request', async () => {
  const sizes = [];
  const rows = [movie(1, { actors: cast }), movie(2, { actors: cast }), movie(3), movie(4), movie(5, { actors: cast })];
  const h = harness(rows, {
    config: { tmdbMatchAiBatchTokens: 1000, tmdbMatchAiBatchMax: 40 },
    rotation: async (req) => { sizes.push(countKeys(req)); return manyChoices(); }
  });
  await refreshTmdbAiMatches(h.deps);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 5);
  const sameTier = harness(rows, { config: { tmdbMatchAiBatchTokens: 1e9, tmdbMatchAiBatchMax: 40 }, rotation: async (req) => { sizes.length = 0; sizes.push(countKeys(req)); return manyChoices(); } });
  const batches = [];
  sameTier.deps.rotation = async (req) => { batches.push(countKeys(req)); return manyChoices(); };
  await refreshTmdbAiMatches(sameTier.deps);
  assert.deepEqual(batches, [2, 2, 1], 'cast films, then cast-less, then the next cast film');
});

test('calibration: the prompt token count a response reports corrects the next packing', async () => {
  const e = await filmChars();
  const { RANK_PROMPT_OVERHEAD_CHARS } = await import('../src/tmdbMatchAi.js');
  const budget = Math.ceil((RANK_PROMPT_OVERHEAD_CHARS + 2.5 * e) / 3);
  const sizes = [];
  const h = harness(Array.from({ length: 12 }, (_, i) => movie(i + 1)), {
    config: { tmdbMatchAiBatchTokens: budget, tmdbMatchAiBatchMax: 40 },
    rotation: async (req) => {
      sizes.push(countKeys(req));
      req.meta.usage = { promptTokens: Math.round(req.text.length / 6), outputTokens: 10, thoughtTokens: 0, totalTokens: 0 }; // twice as dense as assumed
      req.meta.model = 'm'; req.meta.key = 'k1';
      return manyChoices();
    }
  });
  await refreshTmdbAiMatches(h.deps);
  assert.equal(sizes[0], 2);
  assert.ok(sizes[1] >= 4, 'second request packs about twice as many: ' + sizes.join(','));
  assert.ok(h.deps.state.calibration.charsPerToken > 5);
  assert.match(h.logs.at(-1), /tokens=\d+\/30\/0/);
});

test('bisection: a refused batch is halved until the offending film is alone (about 2*log2(N) requests, not N)', async () => {
  const requests = [];
  const rows = Array.from({ length: 8 }, (_, i) => movie(i + 1, i === 5 ? { original_title: 'Poison', title: 'Poison' } : {}));
  const h = harness(rows, {
    config: { tmdbMatchAiBatchMax: 40 },
    rotation: async (req) => { requests.push(countKeys(req)); if (req.text.includes('Poison')) throw new MatchContentError('refused'); return manyChoices(); }
  });
  await refreshTmdbAiMatches(h.deps);
  assert.deepEqual(requests, [8, 4, 4, 2, 1, 1, 2]);
  assert.deepEqual(h.runs.map((r) => r.outcome).sort(), ['error', ...Array(7).fill('verified')].sort());
  assert.equal(h.runs[5].evidence.error, 'model-refused');
});

test('bisection: a provider outage in the middle stops the pass without recording the unranked films', async () => {
  let calls = 0;
  const rows = Array.from({ length: 4 }, (_, i) => movie(i + 1, i === 3 ? { original_title: 'Poison', title: 'Poison' } : {}));
  const h = harness(rows, {
    config: { tmdbMatchAiBatchMax: 40 },
    rotation: async (req) => {
      calls += 1;
      if (calls === 1) throw new MatchContentError('refused');
      if (calls === 3) throw Object.assign(new MatchBlockedError('quota'), { retryAfterMs: 5000 });
      return manyChoices();
    }
  });
  await refreshTmdbAiMatches(h.deps);
  assert.equal(calls, 3);
  assert.equal(h.runs.length, 2, 'only the first half was ranked');
});

test('thinking budget: larger for films without a cast (tier 2), omitted for tier 1 when 0', async () => {
  const bodies = [];
  const rotation = async (req) => { bodies.push(req.buildBody({ id: 'm' })); return manyChoices(); };
  const h = harness([movie(1, { actors: cast }), movie(2)], {
    config: { tmdbMatchAiThinkT1: 0, tmdbMatchAiThinkT2: 4096 }, rotation
  });
  await refreshTmdbAiMatches(h.deps);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  assert.deepEqual(bodies[1].reasoning, { max_tokens: 4096 });
  assert.ok(bodies[1].max_tokens >= 4096 + 1500);
});

test('scope priority and fresh window reach the listing; legacy pass lists scope all', async () => {
  const h = harness([movie(1)], { config: { tmdbMatchAiFreshMs: 777 } });
  await refreshTmdbAiMatches(h.deps);
  assert.equal(h.deps.listArgs.scope, 'all');
  const { runAiMatchPass } = await import('../src/tmdbMatchAiSync.js');
  await runAiMatchPass(h.deps, { scope: 'priority', rowLimit: 9, maxPacks: 1 });
  assert.deepEqual([h.deps.listArgs.scope, h.deps.listArgs.freshMs, h.deps.listArgs.limit], ['priority', 777, 9]);
});

test('listAiMatchCandidates priority scope adds the fresh/retry filter and one parameter', async () => {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  try {
    await listAiMatchCandidates({ mode: 'dry-run', limit: 5, retryMs: 1, errorRetryMs: 2, scope: 'priority', freshMs: 3000 });
  } finally { pool.query = original; }
  const { sql, params } = calls[0];
  assert.deepEqual(params, [1, 2, 'dry-run', 5, 3000]);
  assert.match(sql, /m\.created_at > now\(\) - \$5::bigint/);
  assert.match(sql, /e\.outcome = 'error'/);
  assert.equal(Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))), params.length);
});
