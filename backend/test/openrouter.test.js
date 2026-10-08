import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenRouterRotation, parseOpenRouterModels, classifyRateLimit, chatText, usageOf, utcDay, nextUtcMidnight
} from '../src/openrouter.js';
import { createQuotaLedger } from '../src/aiQuotaLedger.js';
import { openrouterProvider, buildTranslators, createTranslator, TranslateBlockedError } from '../src/translate.js';

const KEY = 'sk-or-v1-secret-key';
const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});
const chat = (content, extra = {}) => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ...extra });
const parse = (json) => chatText(json);
const clock = () => { const t = { now: Date.UTC(2026, 9, 8, 12, 0, 0) }; return { t, now: () => t.now, sleep: async (ms) => { t.now += ms; } }; };
const make = (extra = {}) => {
  const c = clock();
  const calls = [];
  const fetchImpl = extra.fetchImpl ?? (async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return res(200, chat('ok')); });
  const call = createOpenRouterRotation({ apiKeys: [KEY], models: 'a/one:free,b/two', timeoutMs: 1000, cooldownMs: 3600000, now: c.now, sleep: c.sleep, warn: () => {}, ...extra, fetchImpl });
  return { call: (text = 'x') => call({ text, buildBody: () => ({ messages: [] }), parse }), calls, c, raw: call };
};

test('parseOpenRouterModels: :free belongs to the id, trailing numbers are rpm/rpd, free defaults to 20 rpm', () => {
  assert.deepEqual(parseOpenRouterModels('google/gemma-4-31b-it:free, deepseek/deepseek-v4-flash:0, x/y:free:10:500, google/gemma-4-31b-it:free'), [
    { id: 'google/gemma-4-31b-it:free', rpm: 20 },
    { id: 'deepseek/deepseek-v4-flash', rpm: 0 },
    { id: 'x/y:free', rpm: 10, rpd: 500 }
  ]);
  assert.equal(parseOpenRouterModels('deepseek/deepseek-v4-flash')[0].rpm, 0);
});

test('request: bearer key in the header only, model in the body, usage is mapped', async () => {
  const { call, calls, raw } = make();
  const meta = {};
  assert.equal(await raw({ text: 'x', buildBody: () => ({ messages: [] }), parse, meta }), 'ok');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + KEY);
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(calls[0].body.model, 'a/one:free');
  assert.deepEqual(meta.usage, { promptTokens: 100, outputTokens: 50, thoughtTokens: null, totalTokens: 150 });
  assert.equal(meta.model, 'a/one:free');
  void call;
});

test('429 daily on a :free model parks every :free model until the reset and the paid one answers', async () => {
  const seen = [];
  const { call } = make({
    fetchImpl: async (url, init) => {
      const model = JSON.parse(init.body).model;
      seen.push(model);
      return model.endsWith(':free')
        ? res(429, { error: { message: 'Rate limit exceeded: free-models-per-day', metadata: { headers: { 'X-RateLimit-Reset': String(Date.UTC(2026, 9, 9)) } } } })
        : res(200, chat('paid'));
    }
  });
  assert.equal(await call(), 'paid');
  assert.deepEqual(seen, ['a/one:free', 'b/two']);
});

test('429 per-minute honours Retry-After and falls to the next model', async () => {
  const { call, c } = make({
    fetchImpl: async (url, init) => (JSON.parse(init.body).model === 'a/one:free' ? res(429, { error: { message: 'slow down' } }, { 'retry-after': '30' }) : res(200, chat('two')))
  });
  assert.equal(await call(), 'two');
  void c;
});

test('HTTP 200 carrying an error object is handled by its code (502 parks and falls through)', async () => {
  const { call } = make({
    fetchImpl: async (url, init) => (JSON.parse(init.body).model === 'a/one:free' ? res(200, { error: { code: 502, message: 'upstream' } }) : res(200, chat('two')))
  });
  assert.equal(await call(), 'two');
});

test('401 rejects the key: blocked with the status, 402 only parks the paid model', async () => {
  const bad = make({ fetchImpl: async () => res(401, { error: { message: 'no auth' } }) });
  await assert.rejects(bad.call(), (e) => e.blocked === true && e.status === 401);
  const credit = make({ fetchImpl: async (url, init) => (JSON.parse(init.body).model === 'a/one:free' ? res(402, { error: {} }) : res(200, chat('ok'))) });
  assert.equal(await credit.call(), 'ok');
});

test('content refusal (finish_reason content_filter) goes to the next model, then throws the refusal', async () => {
  const filtered = { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] };
  const seen = [];
  const { call } = make({ fetchImpl: async (url, init) => { seen.push(JSON.parse(init.body).model); return res(200, filtered); } });
  await assert.rejects(call(), (e) => e.permanent === true);
  assert.deepEqual(seen, ['a/one:free', 'b/two']);
});

test('daily token cap: persistent ledger counts tokens, over the cap the call is blocked until 00:00 UTC', async () => {
  const c = clock();
  const ledger = createQuotaLedger({ now: c.now, dayOf: utcDay, nextReset: nextUtcMidnight, warn: () => {} });
  let n = 0;
  const call = createOpenRouterRotation({
    apiKeys: [KEY], models: 'a/one:0', timeoutMs: 1000, cooldownMs: 24 * 3600000, dailyTokenCap: 300, ledger,
    now: c.now, sleep: c.sleep, warn: () => {}, fetchImpl: async () => { n += 1; return res(200, chat('ok')); }
  });
  const go = () => call({ text: 'x', buildBody: () => ({}), parse });
  await go(); await go(); // 150 + 150 = 300
  await assert.rejects(go(), (e) => e.blocked === true && /token cap/.test(e.message) && e.retryAfterMs === nextUtcMidnight(c.now()) - c.now());
  assert.equal(n, 2, 'no third request was sent');
  assert.equal(call.quota().remaining, 0);
  c.t.now = nextUtcMidnight(c.now()) + 1000;
  await go();
  assert.equal(n, 3, 'new UTC day: cap resets');
  assert.equal(call.quota().remaining, null);
});

test('rate spacing: a :free model is spaced 3s apart (20 rpm) through the clock', async () => {
  const { call, c } = make({ models: 'a/one:free' });
  await call();
  const first = c.now();
  await call();
  assert.ok(c.now() - first >= 3000);
});

test('chatText / classifyRateLimit / usageOf basics', () => {
  assert.throws(() => chatText({ choices: [] }), /no choice/);
  assert.throws(() => chatText(chat('   ')), /no text/);
  assert.equal(chatText(chat('<think>x</think> Xin chào ')), 'Xin chào');
  assert.equal(chatText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.deepEqual(classifyRateLimit('{"error":{"message":"free-models-per-day"}}', null, 0), { daily: true, delayMs: null });
  assert.equal(classifyRateLimit('x', { get: (n) => (n === 'retry-after' ? '7' : null) }, 0).delayMs, 7000);
  assert.equal(usageOf({ usage: { prompt_tokens: 3, completion_tokens: 2 } }).totalTokens, 5);
  assert.equal(usageOf({}), null);
});

test('openrouterProvider translates with the shared prompt, rejects stray CJK on the first model', async () => {
  const bodies = [];
  const answers = ['xin chào 妻', 'xin chào'];
  const translate = openrouterProvider({
    apiKeys: [KEY], models: 'a/one:0,b/two:0', dailyTokenCap: 0,
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return res(200, chat(answers.shift())); }
  });
  const meta = {};
  assert.equal(await translate('hello', meta), 'xin chào');
  assert.equal(meta.model, 'b/two');
  assert.equal(bodies[0].messages[0].role, 'system');
  assert.equal(bodies[0].messages[1].content, 'hello');
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
});

test('buildTranslators: openrouter is in the chain only with a key; blocked errors are TranslateBlockedError', async () => {
  const settings = { translateProvider: 'openrouter', openrouterApiKeys: [], openrouterTranslateModels: 'a/one:0', openrouterTimeoutMs: 1000, openrouterCooldownMs: 1000, openrouterTranslateDailyTokens: 0 };
  assert.equal(buildTranslators(settings).length, 0);
  const [provider] = buildTranslators({ ...settings, openrouterApiKeys: [KEY] }, { ledger: createQuotaLedger({ warn: () => {} }), fetchImpl: async () => res(401, {}) });
  assert.equal(provider.name, 'openrouter');
  await assert.rejects(provider.translate('hello'), (e) => e instanceof TranslateBlockedError);
  void createTranslator;
});

test('403 "Key limit exceeded" parks the model instead of refusing the text', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    if (model === 'paid/model') return new Response(JSON.stringify({ error: { code: 403, message: 'Key limit exceeded (total limit).' } }), { status: 403 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }), { status: 200 });
  };
  const call = createOpenRouterRotation({ apiKeys: ['k'], models: 'paid/model,x/free:free', scope: 'translate', fetchImpl, warn() {}, sleep: async () => {}, ledger: null });
  const parse = (json) => chatText(json, (m) => new Error(m));
  const out = await call({ text: 'hi', tokens: 1, buildBody: () => ({ messages: [] }), parse });
  assert.equal(out, 'ok');
  await call({ text: 'hi', tokens: 1, buildBody: () => ({ messages: [] }), parse });
  assert.deepEqual(calls, ['paid/model', 'x/free:free', 'x/free:free']);
});
