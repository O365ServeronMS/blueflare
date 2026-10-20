import assert from 'node:assert/strict';
import test from 'node:test';
import { createAi, AiError, AiConfigError, imagePart, readAiConfig, registerRole, fakeTransport } from '../src/ai/index.js';
import { createQuotaLedger } from '../src/aiQuotaLedger.js';
import { checkSchema, extractJson, isFree, parseModels } from '../src/ai/util.js';

const PRIMARY = 'https://llm.example/v1';
const OR = 'https://openrouter.ai/api/v1';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Fetch stand-in: `respond(call)` -> { status, body, headers }; every call is recorded. */
function transport(respond) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization };
    calls.push(call);
    const out = await respond(call, calls.length);
    if (out instanceof Error) throw out;
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    const headers = out.headers ?? {};
    return { ok: out.status < 400, status: out.status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const answer = (content, extra = {}) => ({ status: 200, body: { choices: [{ message: { content }, finish_reason: 'stop' }], ...extra } });
const orUsage = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, completion_tokens_details: { reasoning_tokens: 2 } } };
const env = (over = {}) => ({ OPENROUTER_API_KEY: 'or-key', ...over });
const make = (envVars, respond, extra = {}) => {
  const fetch = transport(respond);
  const warnings = [];
  // Virtual clock: sleep advances it, so waits cost no real time.
  let clock = Date.UTC(2026, 9, 7, 12);
  const ai = createAi({ env: envVars, transport: fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, retryBaseMs: 1, warn: (m) => warnings.push(m), ...extra });
  return { ai, fetch, warnings };
};
const user = (text) => [{ role: 'user', content: text }];
const isPrimary = (call) => call.url.startsWith(PRIMARY);

test('a) without LLM_BASE_URL every call goes to OpenRouter with MODEL_<ROLE>', async () => {
  const { ai, fetch } = make(env({ MODEL_TRANSLATE: 'vendor/one,vendor/two', OPENROUTER_MODEL_TRANSLATE: 'ignored/model' }), () => answer('xin chào', orUsage));
  const result = await ai.chat('TRANSLATE', user('hello'));
  assert.equal(result.text, 'xin chào');
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'vendor/one');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, OR + '/chat/completions');
  assert.equal(fetch.calls[0].auth, 'Bearer or-key');
  assert.deepEqual(ai.modelsFor('TRANSLATE'), [{ provider: 'openrouter', model: 'vendor/one' }, { provider: 'openrouter', model: 'vendor/two' }]);
  // MODEL_PRIMARY is a primary-provider slug: without a primary provider the role falls back to its OpenRouter list.
  const { ai: plain } = make(env({ MODEL_PRIMARY: 'th-only', OPENROUTER_MODEL_TRANSLATE: 'vendor/or' }), () => answer('x'));
  assert.deepEqual(plain.modelsFor('TRANSLATE'), [{ provider: 'openrouter', model: 'vendor/or' }]);
});

test('b) primary 402 / 429 / 5xx falls back to OpenRouter with OPENROUTER_MODEL_<ROLE>', async () => {
  for (const status of [402, 429, 500, 503]) {
    const vars = env({ LLM_BASE_URL: PRIMARY + '/', LLM_API_KEY: 'th-key', MODEL_PRIMARY: 'deep:free', OPENROUTER_MODEL_TRANSLATE: 'or/model' });
    const { ai, fetch } = make(vars, (call) => (isPrimary(call) ? { status, body: { error: { message: 'nope' } } } : answer('ok', orUsage)));
    const result = await ai.chat('TRANSLATE', user('hi'));
    assert.equal(result.provider, 'openrouter', 'status ' + status);
    assert.equal(result.model, 'or/model');
    const primaryCalls = fetch.calls.filter(isPrimary);
    assert.equal(primaryCalls.length, status === 402 ? 1 : 3, 'bounded retries on the same pair for ' + status);
    assert.equal(primaryCalls[0].auth, 'Bearer th-key');
    assert.equal(fetch.calls.at(-1).auth, 'Bearer or-key');
    assert.deepEqual(result.attempts.map((a) => a.provider), [...primaryCalls.map(() => 'llm.example'), 'openrouter']);
    // The next call starts on OpenRouter while the primary pair is parked.
    fetch.calls.length = 0;
    await ai.chat('TRANSLATE', user('again'));
    assert.equal(fetch.calls.filter(isPrimary).length, 0, 'parked after ' + status);
  }
});

test('b) a 401 key and a network error / timeout also fall through, and a 429 retry can succeed', async () => {
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'bad-key', MODEL_PRIMARY: 'deep', OPENROUTER_MODEL_PRIMARY: 'or/model' });
  const { ai, warnings } = make(vars, (call) => (isPrimary(call) ? { status: 401, body: {} } : answer('ok')));
  assert.equal((await ai.chat('TRANSLATE', user('x'))).provider, 'openrouter');
  assert.ok(warnings.some((w) => /llm\.example k1 \([0-9a-f]{6}\) disabled/.test(w)));
  assert.ok(warnings.every((w) => !w.includes('bad-key')), 'keys never reach a log line');
  const { ai: dead } = make(env({ OPENROUTER_API_KEY: 'bad-or-key', OPENROUTER_MODEL_TRANSLATE: 'a/one,b/two' }), () => ({ status: 401, body: {} }));
  const err = await dead.chat('TRANSLATE', user('x')).catch((e) => e);
  assert.ok(err instanceof AiError && err.blocked, 'every key rejected = unavailable');
  assert.ok(!JSON.stringify({ m: err.message, a: err.attempts }).includes('bad-or-key'), 'keys never reach an error');

  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const { ai: flaky } = make(vars, (call) => (isPrimary(call) ? timeout : answer('ok')));
  const r = await flaky.chat('TRANSLATE', user('x'));
  assert.deepEqual(r.attempts.map((a) => a.reason), ['timeout', 'ok']);

  let n = 0;
  const { ai: retry } = make(vars, (call) => (isPrimary(call) && ++n === 1 ? { status: 429, body: {}, headers: { 'retry-after': '1' } } : answer('ok')));
  assert.equal((await retry.chat('TRANSLATE', user('x'))).provider, 'llm.example');
});

test('c) primary body has no usage/reasoning/OpenRouter headers; the OpenRouter body has both', async () => {
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_PRIMARY: 'deep:free', MODEL_FALLBACK: 'mimo:free', OPENROUTER_MODEL_PRIMARY: 'or/m' });
  const { ai, fetch } = make(vars, (call) => (isPrimary(call) ? { status: 503, body: {} } : answer('ok', orUsage)));
  const result = await ai.chat('TRANSLATE', user('hi'), { reasoning: 'high', maxTokens: 100 });
  const primary = fetch.calls.find(isPrimary);
  assert.equal(primary.body.usage, undefined);
  assert.equal(primary.body.reasoning, undefined);
  assert.equal(primary.init.headers['x-title'], undefined);
  assert.equal(primary.init.headers['http-referer'], undefined);
  assert.equal(primary.body.max_tokens, 100);
  assert.equal(primary.body.temperature, 0);
  const or = fetch.calls.at(-1);
  assert.deepEqual(or.body.usage, { include: true });
  assert.deepEqual(or.body.reasoning, { effort: 'high' });
  assert.equal(or.init.headers['x-title'], 'FilmBluesia');
  // Both primary models were tried before OpenRouter, in order.
  assert.deepEqual([...new Set(fetch.calls.filter(isPrimary).map((c) => c.body.model))], ['deep:free', 'mimo:free']);
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, thoughtTokens: 2, totalTokens: 15, cost: 0.0001 });

  // A primary answer without usage or cost is fine: usage null, cost null.
  const { ai: ok } = make(vars, () => answer('ok'));
  assert.equal((await ok.chat('TRANSLATE', user('hi'))).usage, null);
  const { ai: noCost } = make(vars, () => answer('ok', { usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  assert.equal((await noCost.chat('TRANSLATE', user('hi'))).usage.cost, null);

  // reasoning mapping on OpenRouter.
  for (const [value, field] of [['off', { enabled: false }], [{ maxTokens: 512 }, { max_tokens: 512 }], [{ maxTokens: 0 }, { enabled: false }]]) {
    const { ai: r, fetch: f } = make(env({ OPENROUTER_MODEL_TRANSLATE: 'or/m' }), () => answer('ok'));
    await r.chat('TRANSLATE', user('x'), { reasoning: value });
    assert.deepEqual(f.calls[0].body.reasoning, field);
  }
  await assert.rejects(ok.chat('TRANSLATE', user('x'), { reasoning: 'max' }), TypeError);
});

test('d) bad JSON moves to the next pair; when every pair fails AiError lists every reason', async () => {
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_PRIMARY: 'deep', OPENROUTER_MODEL_MATCH: 'or/a,or/b' });
  const { ai } = make(vars, (call) => (call.body.model === 'or/b' ? answer('```json\n{"results":[1]}\n```') : answer('not json at all')));
  const good = await ai.json('MATCH', user('rank'));
  assert.deepEqual(good.data, { results: [1] });
  assert.deepEqual(good.attempts.map((a) => a.model + ':' + a.reason.split(':')[0]), ['deep:bad JSON', 'or/a:bad JSON', 'or/b:ok']);

  const { ai: bad } = make(vars, (call) => (isPrimary(call) ? answer('{"oops"') : call.body.model === 'or/a' ? { status: 400, body: { error: { message: 'bad request' } } } : { status: 200, body: '' }));
  const error = await bad.json('MATCH', user('rank')).catch((e) => e);
  assert.ok(error instanceof AiError);
  assert.equal(error.kind, 'content');
  assert.equal(error.permanent, true);
  assert.deepEqual(error.attempts.map((a) => a.provider + '/' + a.model), ['llm.example/deep', 'openrouter/or/a', 'openrouter/or/a', 'openrouter/or/b']);
  assert.match(error.message, /bad JSON/);
  assert.match(error.message, /empty or non-JSON body/);

  // Schema failure and a throwing accept() are refusals too; parsed value comes from accept().
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
  const { ai: s } = make(vars, (call) => answer(call.body.model === 'or/b' ? '{"n": 2}' : '{"n": "two"}'));
  const out = await s.json('MATCH', user('x'), { schema, accept: (data) => data.n * 10 });
  assert.equal(out.value, 20);
  assert.equal(out.attempts.length, 3);

  // Everything parked/unreachable: kind 'unavailable' with a retry hint, and the blocked flag.
  const { ai: down } = make(vars, () => ({ status: 503, body: {} }));
  const outage = await down.chat('MATCH', user('x')).catch((e) => e);
  assert.equal(outage.kind, 'unavailable');
  assert.equal(outage.blocked, true);
  assert.ok(outage.retryAfterMs >= 1000);
});

test('e) a vision role skips models that cannot read images', async () => {
  registerRole('POSTER_TEST', { vision: true });
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_POSTER_TEST: 'text-only,seeing', OPENROUTER_MODEL_POSTER_TEST: 'or/blind,or/eyes' });
  const respond = (call) => {
    if (call.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'or/blind', architecture: { input_modalities: ['text'] } }, { id: 'or/eyes', architecture: { input_modalities: ['text', 'image'] } }] } };
    if (call.body.model === 'text-only') return { status: 400, body: { error: { message: 'This model does not support image input' } } };
    if (call.body.model === 'seeing') return { status: 503, body: {} };
    return answer('a poster');
  };
  const { ai, fetch } = make(vars, respond);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, imagePart(PNG)] }];
  assert.match(messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  const result = await ai.chat('POSTER_TEST', messages);
  assert.equal(result.model, 'or/eyes');
  assert.ok(!fetch.calls.some((c) => c.body?.model === 'or/blind'), 'catalog says or/blind has no image input');
  // text-only is remembered: the next image call does not try it again.
  fetch.calls.length = 0;
  await ai.chat('POSTER_TEST', messages);
  assert.ok(!fetch.calls.some((c) => c.body?.model === 'text-only'));
  // A text call still uses it.
  fetch.calls.length = 0;
  await ai.chat('POSTER_TEST', user('text'));
  assert.equal(fetch.calls[0].body.model, 'text-only');
  // A non-vision role refuses images outright.
  await assert.rejects(ai.chat('TRANSLATE', messages), TypeError);
  assert.throws(() => imagePart(Buffer.from('nope')), TypeError);
});

test('f) response_format downgrades json_schema -> json_object -> none and remembers per provider+model', async () => {
  const schema = { type: 'object', required: ['ok'] };
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_MATCH: 'deep', OPENROUTER_MODEL_MATCH: 'or/x' });
  const seen = [];
  const { ai, fetch } = make(vars, (call) => {
    seen.push(call.body.response_format?.type ?? 'none');
    if (call.body.response_format) return { status: 400, body: { error: { message: 'response_format is not supported' } } };
    return answer('Sure! ```json\n{"ok": true}\n```');
  });
  const result = await ai.json('MATCH', [{ role: 'system', content: 'You rank.' }, ...user('x')], { schema });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.format, 'none');
  assert.deepEqual(seen, ['json_schema', 'json_object', 'none']);
  assert.equal(fetch.calls.at(-1).body.messages.length, 2, 'instruction merged into the system message');
  assert.match(fetch.calls.at(-1).body.messages[0].content, /You rank\.\n\nAnswer with a single valid JSON value only[\s\S]*JSON schema/);
  seen.length = 0;
  await ai.json('MATCH', user('again'), { schema });
  assert.deepEqual(seen, ['none'], 'the level is remembered');

  // OpenRouter's 404 "no endpoints ... requested parameters" is a format problem, not a dead model.
  const seenOr = [];
  const { ai: or } = make(env({ OPENROUTER_MODEL_MATCH: 'or/x' }), (call) => {
    seenOr.push(call.body.response_format?.type ?? 'none');
    return call.body.response_format?.type === 'json_schema'
      ? { status: 404, body: { error: { message: 'No endpoints found that can handle the requested parameters.' } } }
      : answer('{"ok":true}');
  });
  await or.json('MATCH', user('x'), { schema });
  await or.json('MATCH', user('x'), { schema });
  assert.deepEqual(seenOr, ['json_schema', 'json_object', 'json_object']);
  // Without a schema the ladder starts at json_object.
  const { ai: plain, fetch: f } = make(env({ OPENROUTER_MODEL_MATCH: 'or/x' }), () => answer('{"a":1}'));
  await plain.json('MATCH', user('x'));
  assert.deepEqual(f.calls[0].body.response_format, { type: 'json_object' });
});

test('g) a role added with one line works without touching the module', async () => {
  registerRole('SUMMARY_TEST', { defaultOr: 'vendor/summary:free' });
  const { ai, fetch } = make(env(), () => answer('short'));
  assert.equal(ai.available('SUMMARY_TEST'), true);
  assert.equal((await ai.chat('SUMMARY_TEST', user('long text'))).text, 'short');
  assert.equal(fetch.calls[0].body.model, 'vendor/summary:free');
  const { ai: own } = make(env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_PRIMARY: 'p1', MODEL_FALLBACK: 'p2', MODEL_SUMMARY_TEST: 'mine' }), () => answer('x'));
  assert.deepEqual(own.modelsFor('SUMMARY_TEST'), [{ provider: 'llm.example', model: 'mine' }, { provider: 'openrouter', model: 'vendor/summary:free' }]);
  const { ai: shared } = make(env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_PRIMARY: 'p1', MODEL_FALLBACK: 'p2', OPENROUTER_MODEL_PRIMARY: 'or/shared' }), () => answer('x'));
  assert.deepEqual(shared.modelsFor('SUMMARY_TEST').map((m) => m.model), ['p1', 'p2', 'or/shared']);
  await assert.rejects(ai.chat('NOT_A_ROLE', user('x')), /unknown AI role/);
});

test('h) LLM_BASE_URL without LLM_API_KEY fails at startup with a clear error', () => {
  assert.throws(() => readAiConfig({ LLM_BASE_URL: PRIMARY }), (e) => e instanceof AiConfigError && /LLM_API_KEY is required when LLM_BASE_URL is set/.test(e.message));
  assert.throws(() => createAi({ env: { LLM_BASE_URL: PRIMARY, LLM_API_KEY: ' ' } }), AiConfigError);
  assert.throws(() => readAiConfig({ LLM_BASE_URL: 'not a url', LLM_API_KEY: 'k' }), /not a valid URL/);
  const cfg = readAiConfig({ LLM_BASE_URL: PRIMARY + '//', LLM_API_KEY: 'k' });
  assert.equal(cfg.primary.baseUrl, PRIMARY);
  assert.equal(cfg.primary.name, 'llm.example');
  assert.equal(readAiConfig({}).primary, null);
});

test('deprecated names still work and warn once at startup; new names win', () => {
  const warnings = [];
  const cfg = readAiConfig({
    OPENROUTER_API_KEYS: 'a,b', OPENROUTER_MATCH_MODELS: 'old/m', OPENROUTER_MODEL_TRANSLATE: 'new/t', OPENROUTER_TRANSLATE_MODELS: 'old/t',
    OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS: '500', TMDB_MATCH_AI_TIMEOUT_MS: '90000', OPENROUTER_BASE_URL: 'https://or.example/v1/',
    TMDB_MATCH_AI_RESERVE_PCT: '20', OPENROUTER_COOLDOWN_MS: ''
  }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(cfg.openrouter.keys, ['a', 'b']);
  assert.equal(cfg.openrouter.baseUrl, 'https://or.example/v1');
  assert.equal(cfg.view.OPENROUTER_MODEL_MATCH, 'old/m');
  assert.equal(cfg.view.OPENROUTER_MODEL_TRANSLATE, 'new/t');
  assert.equal(cfg.view.AI_PAID_DAILY_OUTPUT_TOKENS_MATCH, '500');
  assert.equal(cfg.view.AI_TIMEOUT_MS_MATCH, '90000');
  assert.ok(warnings.some((w) => /OPENROUTER_API_KEYS is deprecated, rename it to OPENROUTER_API_KEY/.test(w)));
  assert.ok(warnings.some((w) => /OPENROUTER_TRANSLATE_MODELS is deprecated and ignored because OPENROUTER_MODEL_TRANSLATE/.test(w)));
  assert.ok(warnings.some((w) => /TMDB_MATCH_AI_RESERVE_PCT is no longer read/.test(w)));
  assert.ok(!warnings.some((w) => /OPENROUTER_COOLDOWN_MS/.test(w)), 'empty legacy values are silent');
  assert.ok(!warnings.some((w) => /\ba,b\b/.test(w)));
  assert.equal(readAiConfig({}, { warn: () => assert.fail('no warning without legacy names') }).deprecated.length, 0);
});

test('timeouts: call > AI_TIMEOUT_MS_<ROLE> > AI_TIMEOUT_MS > role default; AI_MAX_TOKENS default', async () => {
  const { ai, fetch } = make(env({ OPENROUTER_MODEL_PRIMARY: 'm' }), () => answer('ok'));
  await ai.chat('TRANSLATE', user('x'));
  assert.equal(fetch.calls[0].body.max_tokens, 8192);
  const { roleTimeoutMs } = await import('../src/ai/config.js');
  assert.equal(roleTimeoutMs(readAiConfig({}), 'MATCH'), 180000);
  assert.equal(roleTimeoutMs(readAiConfig({}), 'TRANSLATE'), 60000);
  assert.equal(roleTimeoutMs(readAiConfig({ AI_TIMEOUT_MS: '30000' }), 'MATCH'), 30000);
  assert.equal(roleTimeoutMs(readAiConfig({ AI_TIMEOUT_MS: '30000', AI_TIMEOUT_MS_MATCH: '200000' }), 'MATCH'), 200000);
  const { ai: m, fetch: f } = make(env({ OPENROUTER_MODEL_PRIMARY: 'm', AI_MAX_TOKENS: '1000' }), () => answer('ok'));
  await m.chat('TRANSLATE', user('x'));
  assert.equal(f.calls[0].body.max_tokens, 1000);
});

test('onCall sees every attempt; the ledger enforces the paid cap per role and counts per key+model', async () => {
  let t = Date.UTC(2026, 9, 7, 12);
  const ledger = createQuotaLedger({ now: () => t, warn: () => {} });
  const records = [];
  const vars = env({ OPENROUTER_MODEL_TRANSLATE: 'p/paid,f/free:free:0', AI_PAID_DAILY_OUTPUT_TOKENS_TRANSLATE: '1000' });
  const { ai, fetch } = make(vars, () => answer('ok', { usage: { prompt_tokens: 10, completion_tokens: 600 } }), { ledger, now: () => t, onCall: (r) => records.push(r) });
  await ai.chat('TRANSLATE', user('a'));
  await ai.chat('TRANSLATE', user('b'));
  await ai.chat('TRANSLATE', user('c'));
  assert.deepEqual(fetch.calls.map((c) => c.body.model), ['p/paid', 'p/paid', 'f/free:free'], 'paid model stops at the cap, :free keeps serving');
  assert.equal(ai.paidTokensToday('TRANSLATE'), 1200);
  assert.equal(records.length, 3);
  assert.deepEqual(Object.keys(records[0]).sort(), ['completionTokens', 'cost', 'error', 'key', 'latencyMs', 'model', 'ok', 'promptTokens', 'provider', 'role', 'status', 'thoughtTokens']);
  assert.equal(records[0].role, 'TRANSLATE');
  assert.equal(records[0].ok, true);
  t += 86400000;
  fetch.calls.length = 0;
  await ai.chat('TRANSLATE', user('d'));
  assert.equal(fetch.calls[0].body.model, 'p/paid', 'a new UTC day resets the cap');
});

test('OpenRouter daily 429 on a :free model parks every :free model of that key; only and signal', async () => {
  const vars = env({ OPENROUTER_MODEL_MATCH: 'a:free,b:free,c/paid' });
  const { ai, fetch, warnings } = make(vars, (call) => (call.body.model.endsWith(':free')
    ? { status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day' } } }
    : answer('{"ok":1}')));
  const out = await ai.json('MATCH', user('x'));
  assert.equal(out.model, 'c/paid');
  assert.deepEqual(fetch.calls.map((c) => c.body.model), ['a:free', 'c/paid']);
  assert.ok(warnings.some((w) => /b:free free-tier daily limit/.test(w)));

  const { ai: one, fetch: f } = make(vars, () => answer('{"ok":1}'));
  await one.json('MATCH', user('x'), { only: { provider: 'openrouter', model: 'b:free' } });
  assert.equal(f.calls[0].body.model, 'b:free');
  const controller = new AbortController();
  controller.abort();
  const stopped = await one.chat('MATCH', user('x'), { signal: controller.signal }).catch((e) => e);
  assert.equal(stopped.kind, 'unavailable');
});

test('content_filter / truncation / accept() refusals end as kind content; a role without providers is unavailable', async () => {
  const { ai } = make(env({ OPENROUTER_MODEL_TRANSLATE: 'a,b' }), (call) => (call.body.model === 'a'
    ? { status: 200, body: { choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] } }
    : answer('tiếng 中文')));
  const error = await ai.chat('TRANSLATE', user('x'), { accept: (text) => { if (/[一-鿿]/.test(text)) throw Object.assign(new Error('stray CJK'), { permanent: true }); return text; } }).catch((e) => e);
  assert.equal(error.kind, 'content');
  assert.deepEqual(error.attempts.map((a) => a.reason), ['refused: content_filter', 'rejected: stray CJK']);
  const { ai: none } = make({}, () => answer('x'));
  assert.equal(none.available('TRANSLATE'), false);
  assert.equal((await none.chat('TRANSLATE', user('x')).catch((e) => e)).kind, 'unavailable');
});

test('AI_FAKE=1 answers without network or keys', async () => {
  const ai = createAi({ env: { AI_FAKE: '1' } });
  assert.equal(ai.available('MATCH'), true);
  assert.equal((await ai.json('MATCH', user('x'))).data.fake, true);
  assert.equal((await ai.chat('TRANSLATE', user('hello'))).text, 'fake: hello');
  const swapped = createAi({ env: env({ OPENROUTER_MODEL_PRIMARY: 'm' }), transport: fakeTransport() });
  assert.equal((await swapped.chat('TRANSLATE', user('hi'))).text, 'fake: hi');
});

test('util: models, JSON extraction, schema subset', () => {
  assert.deepEqual(parseModels('a/b:free, c:10:500, a/b:free'), [{ id: 'a/b:free', rpm: 20 }, { id: 'c', rpm: 10, rpd: 500 }]);
  assert.deepEqual(parseModels('deep:free', { freeRpm: 0 }), [{ id: 'deep:free', rpm: 0 }]);
  assert.deepEqual(extractJson('noise {"a":[1]} tail').value, { a: [1] });
  assert.deepEqual(extractJson('[1,2]').value, [1, 2]);
  assert.equal(extractJson('nothing').ok, false);
  assert.equal(checkSchema({ type: 'array', items: { type: 'object', required: ['k'] } }, [{ k: 1 }, {}]), '$[1].k: required');
  assert.equal(checkSchema({ type: ['string', 'null'] }, null), null);
  assert.equal(checkSchema({ enum: ['a'] }, 'b'), '$: not in enum');
});

test('ported from the old rotation: key only in the header, 200 carrying an error, 403 key limit, Retry-After, :free spacing', async () => {
  // Key travels in Authorization only, never in the URL.
  const plain = make(env({ OPENROUTER_MODEL_MATCH: 'a/one' }), () => answer('ok'));
  await plain.ai.chat('MATCH', user('x'));
  assert.equal(plain.fetch.calls[0].url, OR + '/chat/completions');
  assert.equal(plain.fetch.calls[0].auth, 'Bearer or-key');
  assert.ok(!plain.fetch.calls[0].url.includes('or-key'));

  // HTTP 200 whose body is an error object is handled by its code (502 -> next model).
  const embedded = make(env({ OPENROUTER_MODEL_MATCH: 'a/one,b/two' }), (call) => (call.body.model === 'a/one'
    ? { status: 200, body: { error: { code: 502, message: 'upstream' } } } : answer('two')));
  assert.equal((await embedded.ai.chat('MATCH', user('x'))).value, 'two');

  // 403 "Key limit exceeded" parks the model; the text itself is not refused.
  const limited = make(env({ OPENROUTER_MODEL_MATCH: 'p/paid,f/free:free:0' }), (call) => (call.body.model === 'p/paid'
    ? { status: 403, body: { error: { code: 403, message: 'Key limit exceeded (total limit).' } } } : answer('ok')));
  await limited.ai.chat('MATCH', user('x'));
  await limited.ai.chat('MATCH', user('x'));
  assert.deepEqual(limited.fetch.calls.map((c) => c.body.model), ['p/paid', 'f/free:free', 'f/free:free']);

  // Per-minute 429 with Retry-After moves on to the next model.
  const slow = make(env({ OPENROUTER_MODEL_MATCH: 'a/one,b/two', AI_RETRIES: '0' }), (call) => (call.body.model === 'a/one'
    ? { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '30' } } : answer('two')));
  assert.equal((await slow.ai.chat('MATCH', user('x'))).model, 'b/two');

  // A :free model on OpenRouter gets 20 rpm spacing by default (3s on the virtual clock).
  let clock = Date.UTC(2026, 9, 7, 12);
  const spaced = createAi({ env: env({ OPENROUTER_MODEL_MATCH: 'a/one:free' }), transport: transport(() => answer('ok')), now: () => clock, sleep: async (ms) => { clock += ms; }, warn: () => {} });
  await spaced.chat('MATCH', user('x'));
  const first = clock;
  await spaced.chat('MATCH', user('x'));
  assert.ok(clock - first >= 3000);
});

test('a 429 auth lockout (Token Harbor after bad keys) disables the key at once, no try of the next primary model', async () => {
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'bad', MODEL_PRIMARY: 'deep:free', MODEL_FALLBACK: 'mimo:free', OPENROUTER_MODEL_PRIMARY: 'or/m' });
  const { ai, fetch, warnings } = make(vars, (call) => (isPrimary(call)
    ? { status: 429, body: { error: { message: 'Too many failed authentication attempts. Try again later.', code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '1496' } }
    : answer('ok')));
  const r = await ai.chat('TRANSLATE', user('x'));
  assert.equal(r.provider, 'openrouter');
  assert.deepEqual(r.attempts.map((a) => a.reason), ['http 429 (auth lockout)', 'ok']);
  assert.equal(fetch.calls.filter(isPrimary).length, 1);
  assert.ok(warnings.some((w) => /llm\.example k1 \([0-9a-f]{6}\) disabled: too many failed/.test(w)));
  await ai.chat('TRANSLATE', user('x'));
  assert.equal(fetch.calls.filter(isPrimary).length, 1, 'the key stays off for Retry-After');
});

test('a spent Token Harbor free allowance parks the whole key until the stated reset date', async () => {
  const vars = env({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'th', MODEL_PRIMARY: 'deep:free', MODEL_FALLBACK: 'mimo:free', OPENROUTER_MODEL_PRIMARY: 'or/m' });
  const message = "You've used this period's free allowance. Your next rolling 7-day period starts on 10 Oct 2026 at 01:00 UTC. Use the paid model.";
  const { ai, fetch, warnings } = make(vars, (call) => (isPrimary(call)
    ? { status: 429, body: { error: { message, code: 'free_tier_limit_reached' } }, headers: { 'retry-after': '3600' } }
    : answer('ok')));
  const r = await ai.chat('TRANSLATE', user('x'));
  assert.equal(r.provider, 'openrouter');
  assert.deepEqual(r.attempts.map((a) => a.reason), ['http 429 (free allowance used up)', 'ok']);
  assert.equal(fetch.calls.filter(isPrimary).length, 1, 'the second primary model is not tried');
  assert.ok(warnings.some((w) => /free allowance used up .*parked until 2026-10-10T01:00:00\.000Z/.test(w)));
  await ai.chat('TRANSLATE', user('x'));
  assert.equal(fetch.calls.filter(isPrimary).length, 1, 'no probe before the reset');
});

test('AI_REASONING overrides the caller and reaches both providers', async () => {
  const { createAi } = await import('../src/ai/index.js');
  const seen = [];
  const transport = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (seen.length === 1) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ai = createAi({ env: { LLM_BASE_URL: 'https://p.example/v1', LLM_API_KEY: 'k', MODEL_PRIMARY: 'm', OPENROUTER_API_KEY: 'o', OPENROUTER_MODEL_TRANSLATE: 'x/y', AI_REASONING: 'medium', AI_RETRIES: '0' }, transport, sleep: async () => {}, warn: () => {} });
  await ai.chat('TRANSLATE', [{ role: 'user', content: 'hi' }], { reasoning: 'off' });
  assert.equal(seen[0].body.reasoning_effort, 'medium');
  assert.equal(seen[0].body.reasoning, undefined);
  assert.deepEqual(seen[1].body.reasoning, { effort: 'medium' });
  assert.throws(() => createAi({ env: { AI_REASONING: 'huge' }, transport, warn: () => {} }), /AI_REASONING/);
});

test('DEDUPE borrows the MATCH models and keys unless it names its own, with its own paid cap', async () => {
  const { roleRoutes, rolePaidCap } = await import('../src/ai/config.js');
  const borrowed = readAiConfig({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'k', MODEL_MATCH: 'deep', OPENROUTER_API_KEY: 'or', OPENROUTER_MODEL_MATCH: 'or/m' });
  assert.equal(roleRoutes(borrowed, 'DEDUPE').length, 2);
  assert.equal(JSON.stringify(roleRoutes(borrowed, 'DEDUPE').map((r) => r.models)), JSON.stringify(roleRoutes(borrowed, 'MATCH').map((r) => r.models)));
  const own = readAiConfig({ LLM_BASE_URL: PRIMARY, LLM_API_KEY: 'k', MODEL_MATCH: 'deep', MODEL_DEDUPE: 'wide', OPENROUTER_API_KEY: 'or' });
  assert.match(JSON.stringify(roleRoutes(own, 'DEDUPE')[0].models), /wide/);
  assert.doesNotMatch(JSON.stringify(roleRoutes(own, 'DEDUPE')[0].models), /deep/);
  const capped = readAiConfig({ OPENROUTER_API_KEY: 'or', AI_PAID_DAILY_OUTPUT_TOKENS_MATCH: '100', AI_PAID_DAILY_OUTPUT_TOKENS_DEDUPE: '7' });
  assert.equal(rolePaidCap(capped, 'DEDUPE'), 7);
  assert.equal(rolePaidCap(capped, 'MATCH'), 100);
});

test('openrouter/free counts as a free model', () => {
  assert.equal(isFree('openrouter/free'), true);
  assert.equal(isFree('vendor/model:free'), true);
  assert.equal(isFree('deepseek/deepseek-v4.1-flash-free'), true);
  assert.equal(isFree('deepseek/deepseek-v4.1-flash'), false);
  assert.equal(isFree('openai/gpt-6-luna'), false);
  assert.deepEqual(parseModels('openrouter/free:20:300'), [{ id: 'openrouter/free', rpm: 20, rpd: 300 }]);
});
