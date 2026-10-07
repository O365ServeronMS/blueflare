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
