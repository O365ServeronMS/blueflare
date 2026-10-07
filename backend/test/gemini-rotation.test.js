import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiRotation, nextPacificMidnight } from '../src/geminiRotation.js';
import { createTmdbMatchRotation, tmdbMatchAiAvailable, MatchBlockedError } from '../src/tmdbMatchGemini.js';
import { geminiProvider } from '../src/translate.js';

const K1 = 'AIza-match-key-one';
const K2 = 'AIza-match-key-two';
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const okBody = (text) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
const parse = (json) => json.candidates[0].content.parts[0].text;
const buildBody = () => ({ contents: [] });

function rotation(extra = {}) {
  const log = [];
  const t = { now: 1_700_000_000_000 };
  const fetchImpl = extra.fetchImpl ?? (async (url, init) => { log.push({ url, key: init.headers['x-goog-api-key'] }); return res(200, okBody('ok')); });
  const call = createGeminiRotation({
    apiKeys: [K1], models: 'm1:5,m2:5', timeoutMs: 1000, cooldownMs: 60000,
    now: () => t.now, sleep: async (ms) => { t.now += ms; }, warn: () => {}, ...extra, fetchImpl
  });
  return { call: (text = 'x') => call({ text, buildBody, parse }), log, t };
}

test('rotation: per-minute 429 parks only that pair for retryDelay, next model answers', async () => {
  const seen = [];
  const { call } = rotation({
    fetchImpl: async (url) => { seen.push(url); return url.includes('m1') ? res(429, { error: { details: [{ retryDelay: '20s' }] } }) : res(200, okBody('from-m2')); }
  });
  assert.equal(await call(), 'from-m2');
  seen.length = 0;
  assert.equal(await call(), 'from-m2');
  assert.ok(seen.every((u) => u.includes('m2')), 'm1 is parked, not retried');
});

test('rotation: daily 429 parks the pair until 00:00 America/Los_Angeles', async () => {
  const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
  const state = {};
  const { call } = rotation({
    state, models: 'm1:5', now: () => t0,
    fetchImpl: async () => res(429, { error: { details: [{ '@type': 'QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } })
  });
  await assert.rejects(call(), (e) => e.blocked && e.retryAfterMs === 60000);
  const pair = Object.values(state.pairs)[0];
  assert.equal(pair.until, nextPacificMidnight(t0));
  // 2026-10-07 12:00Z is 05:00 PDT, so reset is 2026-10-08 07:00Z.
  assert.equal(new Date(pair.until).toISOString(), '2026-10-08T07:00:00.000Z');
});

test('rotation: 404 model is off for every key, other model continues', async () => {
  const seen = [];
  const { call, t } = rotation({
    apiKeys: [K1, K2],
    fetchImpl: async (url) => { seen.push(url); return url.includes('m1') ? res(404, { error: { message: 'model not found' } }) : res(200, okBody('ok')); }
  });
  assert.equal(await call(), 'ok');
  assert.equal(seen.filter((u) => u.includes('m1')).length, 1, 'second key does not retry the unknown model');
  seen.length = 0;
  t.now += 30000;
  await call();
  assert.ok(seen.every((u) => u.includes('m2')));
});

test('rotation: 401/403 disables only that key; key never leaks to errors or warnings', async () => {
  const warns = [];
  const { call } = rotation({
    apiKeys: [K1, K2], models: 'm1:5', warn: (m) => warns.push(m),
    fetchImpl: async (url, init) => (init.headers['x-goog-api-key'] === K1 ? res(403, { error: {} }) : res(200, okBody('ok')))
  });
  assert.equal(await call(), 'ok');
  const dead = rotation({ apiKeys: [K1], models: 'm1:5', warn: (m) => warns.push(m), fetchImpl: async () => res(401, { error: {} }) });
  await assert.rejects(dead.call(), (e) => e.blocked && e.status === 401 && !e.message.includes(K1));
  assert.ok(warns.length > 0);
  assert.ok(warns.every((m) => !m.includes(K1) && !m.includes(K2)));
});

test('two rotation instances never share state', async () => {
  const a = rotation({ models: 'm1:5', fetchImpl: async () => res(403, { error: {} }) });
  await assert.rejects(a.call());
  const b = rotation({ models: 'm1:5' });
  assert.equal(await b.call(), 'ok', 'a rejected key in one instance does not disable the other');
  const state1 = {};
  const state2 = {};
  createGeminiRotation({ apiKeys: [K1], models: 'm1', timeoutMs: 1, cooldownMs: 1, state: state1 });
  createGeminiRotation({ apiKeys: [K1], models: 'm1', timeoutMs: 1, cooldownMs: 1, state: state2 });
  assert.notEqual(state1.models, state2.models);
  // Default state is per instance too: parking the translate provider does not park the match instance.
  const tr = geminiProvider({ apiKeys: [K1], models: 'm1', timeoutMs: 1000, cooldownMs: 60000, warn: () => {}, fetchImpl: async () => res(403, { error: {} }) });
  await assert.rejects(tr('hello'));
  const match = createTmdbMatchRotation({
    tmdbMatchAiEnabled: true, tmdbMatchGeminiApiKeys: [K1], tmdbMatchGeminiModels: 'm1:5', tmdbMatchGeminiTimeoutMs: 1000, tmdbMatchGeminiCooldownMs: 60000
  }, { fetchImpl: async () => res(200, okBody('fine')), warn: () => {} });
  assert.equal(await match({ text: 'x', buildBody, parse }), 'fine');
});

test('tmdb match AI is off without its own keys and never uses GEMINI_API_KEYS', () => {
  const base = { tmdbMatchAiEnabled: true, tmdbMatchGeminiModels: 'm1:5', tmdbMatchGeminiTimeoutMs: 1000, tmdbMatchGeminiCooldownMs: 1000, geminiApiKeys: [K1] };
  assert.equal(tmdbMatchAiAvailable({ ...base, tmdbMatchGeminiApiKeys: [] }), false);
  assert.equal(createTmdbMatchRotation({ ...base, tmdbMatchGeminiApiKeys: [] }), null);
  assert.equal(createTmdbMatchRotation({ ...base, tmdbMatchAiEnabled: false, tmdbMatchGeminiApiKeys: [K2] }), null);
  assert.equal(typeof createTmdbMatchRotation({ ...base, tmdbMatchGeminiApiKeys: [K2] }), 'function');
});

test('tmdb match rotation throws MatchBlockedError when every pair is rejected', async () => {
  const call = createTmdbMatchRotation({
    tmdbMatchAiEnabled: true, tmdbMatchGeminiApiKeys: [K1], tmdbMatchGeminiModels: 'm1:5', tmdbMatchGeminiTimeoutMs: 1000, tmdbMatchGeminiCooldownMs: 60000
  }, { fetchImpl: async () => res(403, { error: {} }), warn: () => {} });
  await assert.rejects(call({ text: 'x', buildBody, parse }), (e) => e instanceof MatchBlockedError && e.blocked);
});

test('rotation: 503 parks the pair 45s, doubles on repeat, next model answers in the same call', async () => {
  const seen = [];
  const state = {};
  const { call, t } = rotation({
    state, cooldownMs: 600000,
    fetchImpl: async (url) => { seen.push(url); return url.includes('m1') ? res(503, { error: { message: 'The model is overloaded, high demand' } }) : res(200, okBody('from-m2')); }
  });
  const m1 = () => state.pairs[Object.keys(state.pairs).find((k) => k.endsWith('|m1'))];
  const start = t.now;
  assert.equal(await call(), 'from-m2');
  assert.equal(seen.filter((u) => u.includes('m1')).length, 1);
  assert.equal(m1().until, start + 45000);
  seen.length = 0;
  await call();
  assert.ok(seen.every((u) => u.includes('m2')), 'm1 stays parked, not retried');
  t.now = m1().until + 1;
  const second = t.now;
  await call();
  assert.ok(seen.some((u) => u.includes('m1')), 'retried after the park');
  assert.equal(m1().until, second + 90000, 'second consecutive failure doubles the park');
});

test('rotation: timeout and network errors park the pair like 503; recovery clears the penalty', async () => {
  for (const make of [() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }), () => new TypeError('fetch failed')]) {
    let healthy = false;
    const { call, t } = rotation({
      models: 'm1:5', fetchImpl: async () => { if (!healthy) throw make(); return res(200, okBody('ok')); }
    });
    await assert.rejects(call(), (e) => e.blocked && e.retryAfterMs === 45000);
    await assert.rejects(call(), (e) => e.blocked, 'parked: no new request');
    healthy = true;
    t.now += 45001;
    assert.equal(await call(), 'ok');
  }
});

test('rotation: park never exceeds the max, and warnings carry no key or URL', async () => {
  const warns = [];
  const state = {};
  const { call, t } = rotation({
    state, models: 'm1:5', warn: (m) => warns.push(m), transientParkMs: 100000, transientParkMaxMs: 150000, cooldownMs: 600000,
    fetchImpl: async () => res(502, 'bad gateway')
  });
  await assert.rejects(call(), (e) => e.blocked);
  t.now += 100001;
  await assert.rejects(call(), (e) => e.blocked);
  const pair = Object.values(state.pairs)[0];
  assert.equal(pair.until - t.now, 150000);
  assert.ok(warns.length && warns.every((m) => !m.includes(K1) && !m.includes('http')));
});

test('rotation: a daily 429 still parks until Pacific midnight while 503 on another pair is short', async () => {
  const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
  const state = {};
  const { call } = rotation({
    state, now: () => t0, models: 'm1:5,m2:5',
    fetchImpl: async (url) => (url.includes('m1')
      ? res(429, { error: { details: [{ '@type': 'QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } })
      : res(503, 'high demand'))
  });
  await assert.rejects(call(), (e) => e.blocked);
  const [p1, p2] = Object.entries(state.pairs).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  assert.equal(p1.until, nextPacificMidnight(t0));
  assert.equal(p2.until, t0 + 45000);
});
