import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from '../src/concurrency.js';
import { formatStaleStats, isNotFound, refreshStaleSources } from '../src/staleSources.js';
import { formatMdblistStats } from '../src/mdblistRatingsSync.js';

const quiet = { log() {}, warn() {} };
const settings = { staleMs: 1, batch: 10, concurrency: 2 };

function harness({ rows, detail, notFoundState = { confirmed: false } }) {
  const calls = { marked: [], recorded: [], upserts: [] };
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
