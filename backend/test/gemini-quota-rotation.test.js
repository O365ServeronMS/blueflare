import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiRotation, nextPacificMidnight } from '../src/geminiRotation.js';
import { createMemoryQuotaStore, createQuotaLedger } from '../src/geminiQuotaLedger.js';

const KEY = 'AIza-ledger-key-one';
const KEY2 = 'AIza-ledger-key-two';
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const okBody = (prompt = 1000) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 10, totalTokenCount: prompt + 10 } });
const dailyBody = { error: { details: [{ '@type': 'QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } };
const parse = (json) => json.candidates[0].content.parts[0].text;

/** A rotation over a shared store; `restart()` builds a fresh rotation + ledger the way a new worker process would. */
function world(extra = {}) {
  const t = { now: T0 };
  const store = extra.store ?? createMemoryQuotaStore();
  const fetched = [];
  const sleeps = [];
  const respond = extra.respond ?? (() => res(200, okBody()));
  const build = (overrides = {}) => {
    const ledger = createQuotaLedger({ store, now: () => t.now, warn: () => {} });
    const call = createGeminiRotation({
      apiKeys: [KEY], models: 'm1:5', rpd: 3, timeoutMs: 1000, cooldownMs: 60000,
      now: () => t.now, sleep: async (ms) => { sleeps.push(ms); t.now += ms; }, warn: () => {},
      fetchImpl: async (url, init) => { fetched.push({ model: /models\/([^:]+):/.exec(url)[1], key: init.headers['x-goog-api-key'] }); return respond(fetched.at(-1)); },
      ledger, ...extra.options, ...overrides
    });
    return { call: (extraArgs = {}) => call({ text: 'x', buildBody: () => ({}), parse, ...extraArgs }), raw: call, ledger };
  };
  return { t, store, fetched, sleeps, build, restart: build };
}

test('ledger: a pair with no requests per day left is skipped, then blocked, and never reaches the provider', async () => {
  const w = world();
  const a = w.build();
  for (let i = 0; i < 3; i += 1) { await a.call(); w.t.now += 13000; }
  await assert.rejects(a.call(), (e) => e.blocked === true);
  assert.equal(w.fetched.length, 3);
});

test('ledger: rotation moves to the next model when the first is spent for the day', async () => {
  const w = world({ options: { models: 'm1:5,m2:5', rpd: 1 } });
  const a = w.build();
  await a.call(); w.t.now += 13000;
  await a.call(); w.t.now += 13000;
  assert.deepEqual(w.fetched.map((f) => f.model), ['m1', 'm2']);
  await assert.rejects(a.call(), (e) => e.blocked);
  // a model's own rpd wins over the default
  const own = world({ options: { models: 'm1:5:2,m2:5', rpd: 1 } });
  const b = own.build();
  for (let i = 0; i < 3; i += 1) { await b.call(); own.t.now += 13000; }
  assert.deepEqual(own.fetched.map((f) => f.model), ['m1', 'm1', 'm2']);
});

test('ledger: failed requests (503, timeout) count toward the day', async () => {
  const w = world({ respond: () => res(503, { error: { message: 'high demand' } }), options: { models: 'm1:5', rpd: 10 } });
  const a = w.build();
  await assert.rejects(a.call(), (e) => e.blocked);
  const snap = a.ledger.snapshot((await import('../src/geminiRotation.js')).ledgerFingerprint(KEY), 'm1', w.t.now);
  assert.deepEqual([snap.requests, snap.failures, snap.successes], [1, 1, 0]);
});

test('ledger: restart does not reset the day, a Pacific midnight does', async () => {
  const w = world({ options: { rpd: 2 } });
  const a = w.build();
  await a.call(); w.t.now += 13000;
  await a.call(); w.t.now += 13000;
  const b = w.restart(); // new process: fresh rotation state and a new ledger over the same rows
  await assert.rejects(b.call(), (e) => e.blocked);
  assert.equal(w.fetched.length, 2);
  w.t.now = nextPacificMidnight(T0) + 1000;
  const c = w.restart();
  await c.call();
  assert.equal(w.fetched.length, 3);
});

test('ledger: a daily-quota 429 syncs the counter, so a restarted worker does not ask again', async () => {
  const w = world({ respond: () => res(429, dailyBody), options: { rpd: 20 } });
  const a = w.build();
  await assert.rejects(a.call(), (e) => e.blocked);
  const fp = (await import('../src/geminiRotation.js')).ledgerFingerprint(KEY);
  assert.equal(a.ledger.snapshot(fp, 'm1', w.t.now).requests, 20);
  const b = w.restart();
  await assert.rejects(b.call(), (e) => e.blocked);
  assert.equal(w.fetched.length, 1);
  assert.equal(b.raw.quota().remaining, 0);
});

test('ledger: per-minute spacing survives a restart (the new process waits instead of bursting)', async () => {
  const w = world();
  await w.build().call();
  const sleepsBefore = w.sleeps.length;
  await w.restart().call();
  const waited = w.sleeps.slice(sleepsBefore).reduce((a, b) => a + b, 0);
  assert.ok(waited >= 12000, 'waited ' + waited);
});

test('ledger: token window holds a request until real tokens of the last minute age out', async () => {
  const w = world({ respond: () => res(200, okBody(2000)), options: { tpm: 2500, rpd: 99 } });
  const a = w.build();
  await a.call({ tokens: 2000 });
  w.t.now += 13000; // past RPM spacing but inside the minute
  await assert.rejects(a.call({ tokens: 2000 }), (e) => e.blocked && e.retryAfterMs > 40000 && e.retryAfterMs <= 60000);
  assert.equal(w.fetched.length, 1);
  w.t.now += 61000;
  await a.call({ tokens: 2000 });
  assert.equal(w.fetched.length, 2);
});

test('quota(): remaining and total over live key+model pairs; meta.usage carries the reported tokens', async () => {
  const w = world({ options: { apiKeys: [KEY, KEY2], models: 'm1:5,m2:5', rpd: 20 } });
  const a = w.build();
  await a.raw.ready();
  assert.deepEqual([a.raw.quota().total, a.raw.quota().remaining, a.raw.quota().pairs], [80, 80, 4]);
  const meta = {};
  await a.call({ meta });
  assert.equal(a.raw.quota().remaining, 79);
  assert.deepEqual(meta.usage, { promptTokens: 1000, outputTokens: 10, thoughtTokens: null, totalTokens: 1010 });
  assert.equal(a.raw.quota().resetAt, nextPacificMidnight(w.t.now));
});

test('without a ledger nothing changes: no quota numbers, no day limit', async () => {
  const w = world({ options: { ledger: null, rpd: 1 } });
  const a = w.build({ ledger: null });
  for (let i = 0; i < 3; i += 1) { await a.call(); w.t.now += 13000; }
  assert.equal(w.fetched.length, 3);
  assert.equal(a.raw.quota().total, null);
});

// ---- reliability routing ---------------------------------------------------------------

const flaky = (bad) => (f) => (bad.has(f.model) ? res(503, { error: { message: 'high demand' } }) : res(200, okBody()));

test('reliability: a model that keeps failing is demoted behind healthy ones and stops burning requests', async () => {
  const bad = new Set(['m1']);
  const w = world({ respond: flaky(bad), options: { models: 'm1:5,m2:5', rpd: 50, reliability: { minSamples: 3 } } });
  const a = w.build();
  for (let i = 0; i < 3; i += 1) { await a.call(); w.t.now += 200000; } // m1 fails first, m2 answers
  assert.equal(a.raw.reliability().m1.demoted, true);
  assert.equal(a.raw.reliability().m2.demoted, false);
  w.fetched.length = 0;
  for (let i = 0; i < 3; i += 1) { await a.call(); w.t.now += 200000; }
  assert.deepEqual(w.fetched.map((f) => f.model), ['m2', 'm2', 'm2'], 'm1 is no longer tried first');
});

test('reliability: the demoted model is the last resort, and one success wipes its record', async () => {
  // m2 is rate limited, so only the demoted m1 is left; it answers.
  const w = world({
    respond: (f) => (f.model === 'm2' ? res(429, { error: { details: [{ retryDelay: '30s' }] } }) : res(200, okBody())),
    options: { models: 'm1:5,m2:5', rpd: 50, reliability: { minSamples: 3, probeMs: 1000 } }
  });
  const state = {};
  const a = w.build({ state });
  state.models.m1.recent = [1, 2, 3, 4].map(() => ({ ok: false, at: w.t.now }));
  assert.equal(a.raw.reliability().m1.demoted, true);
  await a.call();
  assert.deepEqual(w.fetched.map((f) => f.model), ['m2', 'm1']);
  assert.equal(a.raw.reliability().m1.demoted, false, 'the success cleared the record');
});

test('reliability: the record expires, so a model that was down is tried again later', async () => {
  const bad = new Set(['m1']);
  const w = world({ respond: flaky(bad), options: { models: 'm1:5,m2:5', rpd: 50, reliability: { minSamples: 3, windowMs: 3600000 } } });
  const a = w.build();
  for (let i = 0; i < 3; i += 1) { await a.call(); w.t.now += 200000; }
  assert.equal(a.raw.reliability().m1.demoted, true);
  w.t.now += 3600000;
  bad.clear();
  w.fetched.length = 0;
  await a.call();
  assert.equal(w.fetched[0].model, 'm1');
});

test('reliability off by default: failing model keeps its place in the order', async () => {
  const bad = new Set(['m1']);
  const w = world({ respond: flaky(bad), options: { models: 'm1:5,m2:5', rpd: 50, ledger: null } });
  const a = w.build({ ledger: null });
  for (let i = 0; i < 6; i += 1) { await a.call(); w.t.now += 400000; }
  assert.equal(w.fetched.filter((f) => f.model === 'm1').length, 6);
});
