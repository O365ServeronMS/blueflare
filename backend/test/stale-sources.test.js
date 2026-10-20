import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from '../src/concurrency.js';
import {
  CONFLICT_RECHECK_MS, DRY_RUN_CONFIRMED_RECHECK_MS, NOT_FOUND_RECHECK_MS, TRANSIENT_RECHECK_MS,
  formatStaleStats, isNotFound, refreshStaleSources
} from '../src/staleSources.js';
import { formatMdblistStats } from '../src/mdblistRatingsSync.js';

const quiet = { log() {}, warn() {} };
const settings = { staleMs: 1, batch: 10, concurrency: 2 };

function harness({ rows, detail, notFoundState = { confirmed: false } }) {
  const calls = { marked: [], recorded: [], upserts: [], deferred: [], deleted: [] };
  const provider = { name: 'kkphim', detail };
  const deps = {
    mapLimit,
    listStale: async () => rows,
    upsert: async (normalized) => {
      calls.upserts.push(normalized);
      return { changed: normalized.changed !== false, movie: { canonical_slug: 'c-' + normalized.slug } };
    },
    recordNotFound: async (id) => { calls.recorded.push(id); return notFoundState; },
    markUnavailable: async (id) => { calls.marked.push(id); return 'slug-' + id; },
    deleteIfNoSource: async (movieId) => { calls.deleted.push(movieId); return 'gone-' + movieId; },
    defer: async (id, ms) => { calls.deferred.push([id, ms]); },
    countDeferred: async () => 0,
    countNoSource: async () => 1,
    countUnseen: async () => 4
  };
  return { calls, provider, deps };
}

const row = (id, slug) => ({ id, movie_id: 'm' + id, provider: 'kkphim', provider_slug: slug });

test('refreshes stale sources and collects changed slugs', async () => {
  const h = harness({
    rows: [row(1, 'a'), row(2, 'b')],
    detail: async (slug) => ({ normalized: { slug, changed: slug === 'a' } })
  });
  const stats = await refreshStaleSources({ mode: 'dry-run', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.equal(stats.refreshed, 2);
  assert.equal(stats.unchanged, 1);
  assert.deepEqual(stats.changedSlugs, ['c-a']);
  assert.equal(stats.unseen, 4);
  assert.match(formatStaleStats(stats), /checked=2 refreshed=2/);
});

test('mode off does nothing', async () => {
  const h = harness({ rows: [row(1, 'a')], detail: async () => { throw new Error('no'); } });
  const stats = await refreshStaleSources({ mode: 'off', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.equal(stats.checked, 0);
});

test('transient errors never count toward unavailability', async () => {
  const h = harness({
    rows: [row(1, 'a')],
    detail: async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); },
    notFoundState: { confirmed: true }
  });
  const stats = await refreshStaleSources({ mode: 'apply', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.equal(stats.transient, 1);
  assert.deepEqual(h.calls.recorded, []);
  assert.deepEqual(h.calls.marked, []);
});

test('dry-run records 404s but never marks unavailable', async () => {
  const h = harness({
    rows: [row(1, 'a')],
    detail: async () => { throw Object.assign(new Error('nf'), { status: 404 }); },
    notFoundState: { confirmed: true }
  });
  const stats = await refreshStaleSources({ mode: 'dry-run', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.equal(stats.notFound, 1);
  assert.equal(stats.wouldMark, 1);
  assert.equal(stats.marked, 0);
  assert.deepEqual(h.calls.marked, []);
});

test('apply marks only confirmed 404s and reports the slug for invalidation', async () => {
  const h = harness({
    rows: [row(1, 'a')],
    detail: async () => { throw Object.assign(new Error('nf'), { status: 404 }); },
    notFoundState: { confirmed: true }
  });
  const stats = await refreshStaleSources({ mode: 'apply', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.deepEqual(h.calls.marked, [1]);
  assert.deepEqual(stats.changedSlugs, ['slug-1']);

  const first = harness({
    rows: [row(2, 'b')],
    detail: async () => { throw Object.assign(new Error('nf'), { status: 404 }); }
  });
  const unconfirmed = await refreshStaleSources({ mode: 'apply', providers: [first.provider], deps: first.deps, settings, log: quiet });
  assert.equal(unconfirmed.marked, 0);
  assert.equal(unconfirmed.notFound, 1);
});

test('apply deletes each movie left without a source once, after its sources are marked', async () => {
  const nf = async () => { throw Object.assign(new Error('nf'), { status: 404 }); };
  const h = harness({
    rows: [row(1, 'a'), { ...row(2, 'b'), movie_id: 'm1' }, row(3, 'c')],
    detail: nf,
    notFoundState: { confirmed: true }
  });
  h.deps.markUnavailable = async (id) => { h.calls.marked.push(id); return id === 3 ? null : 'slug-' + id; };
  h.deps.deleteIfNoSource = async (movieId) => {
    assert.ok(h.calls.marked.includes(1) && h.calls.marked.includes(2), 'delete only after every mark');
    h.calls.deleted.push(movieId);
    return 'gone-' + movieId;
  };
  const stats = await refreshStaleSources({ mode: 'apply', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.deepEqual(h.calls.deleted, ['m1'], 'one call per movie, none when the mark failed');
  assert.equal(stats.deleted, 1);
  assert.match(formatStaleStats(stats), /deleted=1/);
});

test('dry-run never deletes and a failing delete does not break apply', async () => {
  const nf = async () => { throw Object.assign(new Error('nf'), { status: 404 }); };
  const dry = harness({ rows: [row(1, 'a')], detail: nf, notFoundState: { confirmed: true } });
  const dryStats = await refreshStaleSources({ mode: 'dry-run', providers: [dry.provider], deps: dry.deps, settings, log: quiet });
  assert.deepEqual(dry.calls.deleted, []);
  assert.equal(dryStats.deleted, 0);
  assert.equal(dryStats.noSourceMovies, 1);

  const h = harness({ rows: [row(1, 'a'), row(2, 'b')], detail: nf, notFoundState: { confirmed: true } });
  h.deps.deleteIfNoSource = async (movieId) => {
    if (movieId === 'm1') throw new Error('db down');
    return movieId === 'm2' ? null : 'x';
  };
  const stats = await refreshStaleSources({ mode: 'apply', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.equal(stats.marked, 2);
  assert.equal(stats.deleted, 0);
  assert.deepEqual(stats.changedSlugs.sort(), ['slug-1', 'slug-2']);
});

test('isNotFound only matches HTTP 404', () => {
  assert.equal(isNotFound({ status: 404 }), true);
  assert.equal(isNotFound({ status: 500 }), false);
  assert.equal(isNotFound(new Error('x')), false);
});

test('mdblist stats line shows overdue only when known', () => {
  const base = { visible: 0, selected: 0, batches: 0, reserved: 0, spent: 0, matched: 0, partial: 0, unmatched: 0,
    tomatoes: 0, audience: 0, noId: 0, keysTried: 0, keysTotal: 0, keysDrained: 0, durationMs: 0, errors: {} };
  assert.doesNotMatch(formatMdblistStats(base), /overdue/);
  assert.match(formatMdblistStats({ ...base, overdue: 12 }), /overdue=12/);
});

test('unique violations are counted apart and the source is deferred', async () => {
  const h = harness({
    rows: [row(1, 'a'), row(2, 'b')],
    detail: async (slug) => {
      if (slug === 'a') throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { normalized: { slug } };
    }
  });
  const first = await refreshStaleSources({ mode: 'dry-run', providers: [h.provider], deps: h.deps, settings, log: quiet });
  assert.equal(first.conflicts, 1);
  assert.equal(first.transient, 0);
  assert.equal(first.refreshed, 1);
  assert.deepEqual(h.calls.deferred, [[1, CONFLICT_RECHECK_MS]]);
  assert.deepEqual(h.calls.recorded, []);
});

const fail404 = async () => { throw Object.assign(new Error('nf'), { status: 404 }); };
const run = (h, mode) => refreshStaleSources({ mode, providers: [h.provider], deps: h.deps, settings, log: quiet });

test('every failed attempt defers the source by its own delay', async () => {
  let h = harness({ rows: [row(1, 'a')], detail: fail404 });
  await run(h, 'dry-run');
  assert.deepEqual(h.calls.deferred, [[1, NOT_FOUND_RECHECK_MS]]);

  h = harness({ rows: [row(1, 'a')], detail: fail404, notFoundState: { confirmed: true } });
  await run(h, 'dry-run');
  assert.deepEqual(h.calls.deferred, [[1, DRY_RUN_CONFIRMED_RECHECK_MS]]);

  h = harness({ rows: [row(1, 'a')], detail: async () => { throw Object.assign(new Error('x'), { status: 503 }); } });
  await run(h, 'apply');
  assert.deepEqual(h.calls.deferred, [[1, TRANSIENT_RECHECK_MS]]);

  h = harness({ rows: [row(1, 'a')], detail: fail404 });
  h.deps.recordNotFound = async () => { throw new Error('db down'); };
  await run(h, 'apply');
  assert.deepEqual(h.calls.deferred, [[1, TRANSIENT_RECHECK_MS]]);

  h = harness({ rows: [row(1, 'a')], detail: fail404, notFoundState: { confirmed: true } });
  h.deps.markUnavailable = async () => null;
  await run(h, 'apply');
  assert.deepEqual(h.calls.deferred, [[1, TRANSIENT_RECHECK_MS]]);

  h = harness({ rows: [row(1, 'a')], detail: fail404, notFoundState: { confirmed: true } });
  await run(h, 'apply');
  assert.deepEqual(h.calls.deferred, [], 'a marked source leaves the lane on its own');

  h = harness({ rows: [row(1, 'a')], detail: async (slug) => ({ normalized: { slug } }) });
  await run(h, 'apply');
  assert.deepEqual(h.calls.deferred, []);
});

test('a failing defer does not break the run', async () => {
  const h = harness({ rows: [row(1, 'a'), row(2, 'b')], detail: fail404 });
  h.deps.defer = async () => { throw new Error('db down'); };
  const stats = await run(h, 'dry-run');
  assert.equal(stats.notFound, 2);
  assert.equal(stats.checked, 2);
});

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const cycleSettings = { staleMs: 14 * DAY, batch: 150, concurrency: 4 };

// In-memory stand-in for movie_provider_sources and its stale-lane queries.
function simulation({ failure }) {
  const clock = { now: Date.parse('2026-10-20T00:00:00Z') };
  const rows = [];
  for (let i = 0; i < 300; i += 1) {
    rows.push({
      id: i, provider: 'kkphim', provider_slug: 's' + i, movie_id: 'm' + i,
      last_success_at: clock.now - 30 * DAY + i, next_check_at: null, not_found_count: 0, first_nf: null
    });
  }
  const bad = new Set(rows.slice(0, 150).map((r) => r.provider_slug));
  const checked = [];
  const byId = (id) => rows.find((r) => r.id === id);
  const deps = {
    mapLimit,
    listStale: async (_p, staleMs, batch) => rows
      .filter((r) => r.last_success_at < clock.now - staleMs && (r.next_check_at == null || r.next_check_at <= clock.now))
      .sort((a, b) => a.last_success_at - b.last_success_at)
      .slice(0, batch),
    upsert: async (normalized) => {
      byId(Number(normalized.slug.slice(1))).last_success_at = clock.now;
      byId(Number(normalized.slug.slice(1))).next_check_at = null;
      return { changed: true, movie: { canonical_slug: 'c-' + normalized.slug } };
    },
    recordNotFound: async (id, gap) => {
      const r = byId(id);
      r.not_found_count += 1;
      if (r.first_nf == null) { r.first_nf = clock.now; return { confirmed: false }; }
      return { confirmed: clock.now - r.first_nf >= gap };
    },
    markUnavailable: async (id) => { byId(id).last_success_at = Infinity; return 'slug-' + id; },
    deleteIfNoSource: async () => null,
    defer: async (id, ms) => { byId(id).next_check_at = clock.now + ms; },
    countDeferred: async () => rows.filter((r) => r.next_check_at > clock.now).length,
    countNoSource: async () => 0,
    countUnseen: async () => 0
  };
  const provider = {
    name: 'kkphim',
    detail: async (slug) => {
      checked.push(slug);
      if (bad.has(slug)) throw failure();
      return { normalized: { slug } };
    }
  };
  const cycle = (mode) => refreshStaleSources({ mode, providers: [provider], deps, settings: cycleSettings, log: quiet });
  return { clock, cycle, checked, rows };
}

const notFound = () => Object.assign(new Error('nf'), { status: 404 });
const transient = () => Object.assign(new Error('HTTP 503'), { status: 503 });

for (const [label, failure] of [['404', notFound], ['transient error', transient]]) {
  test('failing sources at the head of the queue do not block the rest (' + label + ')', async () => {
    const sim = simulation({ failure });
    const perCycle = [];
    for (let i = 0; i < 3; i += 1) {
      const before = sim.checked.length;
      await sim.cycle('dry-run');
      perCycle.push(sim.checked.slice(before));
      sim.clock.now += 15 * MIN;
    }
    assert.equal(perCycle[0].length, 150);
    assert.equal(perCycle[1].length, 150);
    assert.equal(new Set([...perCycle[0], ...perCycle[1]]).size, 300, 'cycle 2 must check other rows than cycle 1');
    assert.equal(new Set(sim.checked).size, sim.checked.length, 'no row checked twice in 3 cycles');
    assert.equal(new Set(sim.checked).size, 300);
  });
}

test('404 sources come back after the confirm gap and are marked in apply mode', async () => {
  const sim = simulation({ failure: notFound });
  await sim.cycle('dry-run');
  sim.clock.now += NOT_FOUND_RECHECK_MS;
  const stats = await sim.cycle('apply');
  assert.equal(stats.notFound, 150);
  assert.equal(stats.wouldMark, 150);
  assert.equal(stats.marked, 150);
});
