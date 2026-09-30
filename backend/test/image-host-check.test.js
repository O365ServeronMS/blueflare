import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe, judgeSamples, nextHostState, probeUrl } from '../src/imageHostHealth.js';
import { runImageHostCheck } from '../src/imageHostCheck.js';
import { deadImageHosts, isAllowedImageHost, setLearnedDeadHosts } from '../src/imageHostRegistry.js';

test('classifyProbe separates gone from transient', () => {
  assert.equal(classifyProbe({ status: 200 }), 'ok');
  assert.equal(classifyProbe({ status: 206 }), 'ok');
  assert.equal(classifyProbe({ status: 404 }), 'gone');
  assert.equal(classifyProbe({ status: 410 }), 'gone');
  assert.equal(classifyProbe({ status: 429 }), 'transient');
  assert.equal(classifyProbe({ status: 503 }), 'transient');
  assert.equal(classifyProbe({ error: Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }) }), 'gone');
  assert.equal(classifyProbe({ error: new Error('timeout') }), 'transient');
});

test('judgeSamples needs every sample gone to call a host dead', () => {
  assert.equal(judgeSamples([]), 'unknown');
  assert.equal(judgeSamples(['gone', 'ok', 'gone']), 'alive');
  assert.equal(judgeSamples(['gone', 'gone']), 'dead');
  assert.equal(judgeSamples(['gone', 'transient']), 'unknown');
});

test('nextHostState marks dead only after consecutive failures and revives on ok', () => {
  const opts = { deadAfter: 3, now: new Date('2026-10-01T00:00:00Z') };
  let state = nextHostState(null, 'dead', opts);
  assert.equal(state.status, 'alive');
  state = nextHostState(state, 'unknown', opts);
  assert.equal(state.consecutive_failures, 1);
  state = nextHostState(state, 'dead', opts);
  state = nextHostState(state, 'dead', opts);
  assert.equal(state.status, 'dead');
  assert.ok(state.dead_since);
  state = nextHostState(state, 'alive', opts);
  assert.equal(state.status, 'alive');
  assert.equal(state.consecutive_failures, 0);
  assert.equal(state.dead_since, null);
});

test('probeUrl reports network failure as transient and 404 as gone', async () => {
  const body = { cancel: async () => {} };
  assert.equal(await probeUrl('https://a/x', { fetchImpl: async () => ({ status: 404, body }) }), 'gone');
  assert.equal(await probeUrl('https://a/x', { fetchImpl: async () => { throw new Error('boom'); } }), 'transient');
});

function harness(rows, samples) {
  const saved = new Map(rows.map((row) => [row.host, row]));
  const calls = { purge: 0, dead: [] };
  return {
    saved,
    calls,
    deps: {
      loadHealth: async () => [...saved.values()],
      saveHealth: async (host, state, detail) => saved.set(host, { host, checked_at: new Date(), ...state, detail }),
      sampleUrls: async (host) => samples[host] || [],
      probe: async (url) => (url.includes('gone') ? 'gone' : 'ok'),
      setDead: (hosts) => { calls.dead = hosts; },
      deadHosts: () => calls.dead,
      purge: async () => { calls.purge += 1; return { slugs: ['a'], assetsDeleted: 2 }; }
    }
  };
}
const settings = { intervalMs: 86400000, samples: 3, deadAfter: 2, purgeAllowed: true };

test('runImageHostCheck flags a host dead after repeated failures and purges', async () => {
  const h = harness([], { 'a.test': ['https://a.test/gone1', 'https://a.test/gone2'], 'b.test': ['https://b.test/ok'] });
  let result = await runImageHostCheck({ hosts: ['a.test', 'b.test'], settings, deps: h.deps, now: Date.now() });
  assert.deepEqual(result.dead, []);
  result = await runImageHostCheck({ hosts: ['a.test', 'b.test'], settings, deps: h.deps, now: Date.now() + 86400000 });
  assert.deepEqual(result.dead, ['a.test']);
  assert.deepEqual(result.changedSlugs, ['a']);
  assert.equal(h.saved.get('b.test').status, 'alive');
});

test('runImageHostCheck does nothing before the interval elapses', async () => {
  const h = harness([{ host: 'a.test', status: 'alive', consecutive_failures: 0, checked_at: new Date() }], {});
  assert.equal(await runImageHostCheck({ hosts: ['a.test'], settings, deps: h.deps, now: Date.now() + 1000 }), null);
});

test('runImageHostCheck ignores a total outage and skips purge when not allowed', async () => {
  const h = harness([], { 'a.test': ['https://a.test/gone'], 'b.test': ['https://b.test/gone'] });
  const result = await runImageHostCheck({
    hosts: ['a.test', 'b.test'], settings: { ...settings, deadAfter: 1, purgeAllowed: false }, deps: h.deps, now: Date.now()
  });
  assert.deepEqual(result.dead, []);
  assert.equal(h.calls.purge, 0);
});

test('learned dead hosts leave the effective allowlist', () => {
  assert.equal(isAllowedImageHost('phimimg.com'), true);
  setLearnedDeadHosts(['phimimg.com']);
  assert.equal(isAllowedImageHost('phimimg.com'), false);
  assert.ok(deadImageHosts().includes('phimimg.com'));
  setLearnedDeadHosts([]);
});
