import assert from 'node:assert/strict';
import test from 'node:test';
import { aiLoopEnabled, runTmdbMatchAiLoop, tmdbMatchAiTick } from '../src/tmdbMatchAiLoop.js';
import { MatchBlockedError } from '../src/tmdbMatchGemini.js';

const settings = (over = {}) => ({
  tmdbEnabled: true, tmdbApiKey: 't', tmdbMatchAiEnabled: true, tmdbMatchGeminiApiKeys: ['k'], tmdbMatchAiMode: 'dry-run',
  tmdbMatchAiLimit: 100, tmdbMatchAiRetryMs: 1, tmdbMatchAiErrorRetryMs: 1, tmdbMatchGeminiBatchMax: 3, tmdbMatchConcurrency: 2,
  tmdbMatchAiLoop: true, tmdbMatchAiLoopMs: 60000, tmdbMatchAiReservePct: 10, tmdbMatchAiFreshMs: 1000, ...over
});
const movie = (n) => ({ id: 'id' + n, canonical_slug: 's' + n, title: 'Mây Họa Ánh Trăng', original_title: 'Moonlight Drawn By Clouds', year: 2016, media_type: 'tv', countries: [], actors: [], episode_total: '18', duration: '60' });
const detail = { id: 1, name: 'Moonlight Drawn By Clouds', original_name: 'Moonlight Drawn By Clouds', first_air_date: '2016-08-22', number_of_seasons: 1, number_of_episodes: 18, episode_run_time: [60] };
const client = (empty = false) => ({ get: async (path) => (path.startsWith('/search/') ? { results: empty ? [] : [{ id: 1, name: detail.name, first_air_date: '2016-08-22', vote_count: 5 }] } : detail) });
const picks = async () => new Map(Array.from({ length: 10 }, (_, i) => ['m' + i, { chosenId: 'tv:1', confidence: 0.9, reasons: [] }]));

/** Rotation stand-in with a quota that shrinks per request, like the ledger-backed one. */
function fakeRotation({ total = 60, remaining = 60, resetAt = 10_000_000, fail } = {}) {
  const q = { total, remaining, resetAt };
  const rotation = async () => { if (fail) throw fail; q.remaining -= 1; return picks(); };
  rotation.ready = async () => {};
  rotation.quota = () => ({ ...q, pairs: 3 });
  rotation.state = q;
  return rotation;
}

function harness({ lists = {}, quota = {}, config = {}, rotationFail, empty = false } = {}) {
  const calls = [];
  const runs = [];
  const logs = [];
  const queues = { priority: [...(lists.priority ?? [])], all: [...(lists.all ?? [])] };
  const rotation = fakeRotation({ ...quota, fail: rotationFail });
  const deps = {
    config: settings(config), rotation, client: client(empty), state: {}, log: (m) => logs.push(m), warn: (m) => logs.push(m),
    now: () => 5_000_000,
    list: async (args) => { calls.push(args.scope); return (queues[args.scope] ?? []).splice(0, args.limit); },
    record: async (run) => { runs.push(run); }
  };
  return { deps, calls, runs, logs, rotation };
}

test('the loop flag defaults on and only an explicit false hands the pass back to the sync cycle', () => {
  assert.equal(aiLoopEnabled({}), true);
  assert.equal(aiLoopEnabled({ tmdbMatchAiLoop: true }), true);
  assert.equal(aiLoopEnabled({ tmdbMatchAiLoop: false }), false);
});

test('tick is off without AI, keys or mode', async () => {
  for (const config of [{ tmdbMatchAiMode: 'off' }, { tmdbMatchGeminiApiKeys: [] }, { tmdbMatchAiEnabled: false }]) {
    const h = harness({ config, lists: { priority: [movie(1)] } });
    assert.equal((await tmdbMatchAiTick(h.deps)).status, 'off');
    assert.deepEqual(h.calls, []);
  }
});

test('tick with no requests left skips all database and TMDB work and reports when the quota returns', async () => {
  const h = harness({ quota: { remaining: 0, resetAt: 5_600_000 }, lists: { priority: [movie(1)] } });
  const tick = await tmdbMatchAiTick(h.deps);
  assert.deepEqual([tick.status, tick.retryAfterMs], ['quota', 600_000]);
  assert.deepEqual(h.calls, []);
});

test('tick serves new films and retries (priority) before the backlog, one batch per tick', async () => {
  const h = harness({ lists: { priority: [movie(1), movie(2)], all: [movie(3)] } });
  const tick = await tmdbMatchAiTick(h.deps);
  assert.deepEqual([tick.status, tick.requests], ['worked', 1]);
  assert.deepEqual(h.calls, ['priority']);
  assert.deepEqual(h.runs.map((r) => r.movieId), ['id1', 'id2']);
  assert.equal(h.rotation.state.remaining, 59);
});

test('tick leaves the reserve alone: the backlog runs only while more than 10% of the day is left', async () => {
  const low = harness({ quota: { total: 60, remaining: 6 }, lists: { all: [movie(1)] } });
  assert.equal((await tmdbMatchAiTick(low.deps)).status, 'idle');
  assert.deepEqual(low.calls, ['priority'], 'only the reserved scope may spend the last 6');
  assert.equal(low.runs.length, 0);

  const ok = harness({ quota: { total: 60, remaining: 7 }, lists: { all: [movie(1)] } });
  const tick = await tmdbMatchAiTick(ok.deps);
  assert.equal(tick.status, 'worked');
  assert.deepEqual(ok.calls, ['priority', 'all']);

  const none = harness({ quota: { total: 60, remaining: 7 }, config: { tmdbMatchAiReservePct: 0 } });
  await tmdbMatchAiTick(none.deps);
  assert.deepEqual(none.calls, ['priority', 'all']);
});

test('films that need no model are finished without a request and the tick keeps going until it makes one or the list is empty', async () => {
  const noCandidates = harness({ empty: true, lists: { priority: [movie(1), movie(2), movie(3), movie(4), movie(5)] } });
  const tick = await tmdbMatchAiTick(noCandidates.deps);
  assert.equal(tick.requests, 0);
  assert.equal(noCandidates.runs.length, 5);
  assert.deepEqual(noCandidates.calls.filter((c) => c === 'priority').length, 3, '3 + 2 listed, then an empty listing');
  assert.equal(noCandidates.rotation.state.remaining, 60, 'no quota spent');
});

test('a blocked rotation ends the tick with its retry time and records nothing', async () => {
  const h = harness({ rotationFail: Object.assign(new MatchBlockedError('quota'), { retryAfterMs: 90_000 }), lists: { priority: [movie(1)] } });
  const tick = await tmdbMatchAiTick(h.deps);
  assert.deepEqual([tick.status, tick.retryAfterMs], ['blocked', 90_000]);
  assert.equal(h.runs.length, 0);
});

test('apply mode: changed slugs reach onChanged', async () => {
  const h = harness({ config: { tmdbMatchAiMode: 'apply' }, lists: { priority: [movie(1)] } });
  h.deps.assign = async () => ({ action: 'merged', survivorSlug: 'kk', droppedSlug: 's1' });
  const ctrl = new AbortController();
  const changed = [];
  await runTmdbMatchAiLoop({
    ...h.deps, signal: ctrl.signal, onChanged: (slugs) => changed.push(...slugs),
    sleep: async () => ctrl.abort()
  });
  assert.deepEqual(changed.sort(), ['kk', 's1']);
});

test('loop: wakes at the configured interval, idles slower, backs off after quota/blocked, and logs a state change once', async () => {
  const h = harness({ quota: { remaining: 0, resetAt: 5_000_000 + 3_600_000 } });
  const ctrl = new AbortController();
  const delays = [];
  await runTmdbMatchAiLoop({
    ...h.deps, signal: ctrl.signal,
    sleep: async (ms) => { delays.push(ms); if (delays.length === 3) ctrl.abort(); }
  });
  assert.deepEqual(delays, [900_000, 900_000, 900_000], 'quota spent: waits (capped at 15 min) instead of every minute');
  assert.equal(h.logs.filter((m) => /loop: quota/.test(m)).length, 1);

  const idle = harness();
  const c2 = new AbortController();
  const d2 = [];
  await runTmdbMatchAiLoop({ ...idle.deps, signal: c2.signal, sleep: async (ms) => { d2.push(ms); c2.abort(); } });
  assert.deepEqual(d2, [300_000], 'empty backlog: 5x the interval');

  const busy = harness({ lists: { priority: [movie(1)] } });
  const c3 = new AbortController();
  const d3 = [];
  await runTmdbMatchAiLoop({ ...busy.deps, signal: c3.signal, sleep: async (ms) => { d3.push(ms); c3.abort(); } });
  assert.deepEqual(d3, [60_000]);
});

test('loop: a failing tick is logged and retried with growing delay, never thrown', async () => {
  const h = harness({ lists: { priority: [movie(1)] } });
  h.deps.list = async () => { throw new Error('db down'); };
  const ctrl = new AbortController();
  const delays = [];
  await runTmdbMatchAiLoop({ ...h.deps, signal: ctrl.signal, sleep: async (ms) => { delays.push(ms); if (delays.length === 3) ctrl.abort(); } });
  assert.deepEqual(delays, [60_000, 120_000, 240_000]);
  assert.ok(h.logs.some((m) => /tick failed: db down/.test(m)));
});

test('loop: SIGTERM semantics - an aborted signal stops it at once, and mid-tick it finishes the current batch but starts no further sweep', async () => {
  const pre = harness({ lists: { priority: [movie(1)] } });
  const aborted = new AbortController();
  aborted.abort();
  await runTmdbMatchAiLoop({ ...pre.deps, signal: aborted.signal, sleep: async () => assert.fail('must not sleep') });
  assert.deepEqual(pre.calls, [], 'no tick after the abort');

  const mid = harness({ empty: true, lists: { priority: Array.from({ length: 20 }, (_, i) => movie(i + 1)) } });
  const ctrl = new AbortController();
  const baseList = mid.deps.list;
  mid.deps.list = async (args) => { const rows = await baseList(args); ctrl.abort(); return rows; }; // SIGTERM arrives while listing
  await runTmdbMatchAiLoop({ ...mid.deps, signal: ctrl.signal, sleep: async () => {} });
  assert.equal(mid.calls.length, 1, 'no second sweep after the stop request');
});
