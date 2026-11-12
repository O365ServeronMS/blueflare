import assert from 'node:assert/strict';
import test from 'node:test';
import { createAi, AiError, AiConfigError, imagePart, readAiConfig, registerRole, fakeTransport } from '../src/ai/index.js';
import { createQuotaLedger } from '../src/aiQuotaLedger.js';
import { checkSchema, extractJson, isFree, parseModels } from '../src/ai/util.js';

// A role of the test's own: the module ships MATCH and DEDUPE only, both with defaults.
registerRole('SAMPLE');

const OC = 'http://opencode:4096';
const OR = 'https://openrouter.ai/api/v1';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/**
 * Fetch stand-in: `respond(call)` -> { status, body, headers }; every call is recorded. opencode
 * session creation is answered here (`ses_<n>`) and recorded in `sessions`, not `calls`, unless
 * `{ sessions: respondToo }` asks for it to go through `respond` as well.
 */
function transport(respond, { sessions: own = false } = {}) {
  const calls = [];
  const sessions = [];
  const fn = async (url, init = {}) => {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization };
    if (!own && url.endsWith('/api/session')) {
      sessions.push(call);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: 'ses_' + sessions.length } }) };
    }
    calls.push(call);
    const out = await respond(call, calls.length);
    if (out instanceof Error) throw out;
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    const headers = out.headers ?? {};
    return { ok: out.status < 400, status: out.status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => text };
  };
  fn.calls = calls;
  fn.sessions = sessions;
  return fn;
}

const answer = (content, extra = {}) => ({ status: 200, body: { choices: [{ message: { content }, finish_reason: 'stop' }], ...extra } });
const orUsage = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001, completion_tokens_details: { reasoning_tokens: 2 } } };
const env = (over = {}) => ({ OPENROUTER_API_KEY: 'or-key', ...over });
const make = (envVars, respond, extra = {}, transportOptions = {}) => {
  const fetch = transport(respond, transportOptions);
  const warnings = [];
  // Virtual clock: sleep advances it, so waits cost no real time.
  let clock = Date.UTC(2026, 9, 7, 12);
  const ai = createAi({ env: envVars, transport: fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, retryBaseMs: 1, warn: (m) => warnings.push(m), ...extra });
  return { ai, fetch, warnings };
};
const user = (text) => [{ role: 'user', content: text }];
const isOc = (call) => call.url.startsWith(OC);
const ocEnv = (over = {}) => env({ OPENCODE_URL: OC + '/', OPENCODE_SERVER_PASSWORD: 'oc-pass', ...over });
const ocAnswer = (text, tokens) => ({ status: 200, body: { data: { text, ...(tokens ? { tokens, cost: 0 } : {}) } } });
const ocBusy = (message) => ({ status: 503, body: { _tag: 'ServiceUnavailableError', message, service: 'session generation' } });
const ocFail = (reason, extra = {}) => ({ status: 502, body: { _tag: 'ProviderRequestError', providerID: 'opencode', reason, message: 'nope', ...extra } });
/** The right success shape for whichever provider the call went to. */
const reply = (call, text) => (isOc(call) ? ocAnswer(text) : answer(text));
const modelOf = (call) => call.body.model;

test('a) without OPENCODE_URL every call goes to OpenRouter with OPENROUTER_MODEL_<ROLE>', async () => {
  const { ai, fetch } = make(env({ OPENROUTER_MODEL_SAMPLE: 'vendor/one,vendor/two', OPENCODE_MODEL_SAMPLE: 'opencode/ignored' }), () => answer('xin chào', orUsage));
  const result = await ai.chat('SAMPLE', user('hello'));
  assert.equal(result.text, 'xin chào');
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'vendor/one');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, OR + '/chat/completions');
  assert.equal(fetch.calls[0].auth, 'Bearer or-key');
  assert.deepEqual(ai.modelsFor('SAMPLE'), [{ provider: 'openrouter', model: 'vendor/one' }, { provider: 'openrouter', model: 'vendor/two' }]);
  // MATCH defaults: opencode/big-pickle first when the sidecar is configured, openrouter/free after.
  assert.deepEqual(make(ocEnv(), () => answer('x')).ai.modelsFor('MATCH'), [{ provider: 'opencode', model: 'opencode/big-pickle' }, { provider: 'openrouter', model: 'openrouter/free' }]);
  assert.deepEqual(make(env(), () => answer('x')).ai.modelsFor('MATCH'), [{ provider: 'openrouter', model: 'openrouter/free' }]);
});

test('a) opencode: one plan-agent session per model, then a generate call with basic auth and a flattened prompt', async () => {
  const tokens = { input: 71, output: 12, reasoning: 3, cache: { read: 9216, write: 0 } };
  const { ai, fetch } = make(ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/big-pickle,opencode/glm-5.3-flash-free', OPENROUTER_MODEL_SAMPLE: 'or/m' }), () => ocAnswer('xin chào', tokens));
  const result = await ai.chat('SAMPLE', [{ role: 'system', content: 'Be brief.' }, ...user('hello')], { reasoning: 'high', maxTokens: 100 });
  assert.equal(result.text, 'xin chào');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'opencode/big-pickle');
  assert.deepEqual(result.usage, { promptTokens: 9287, completionTokens: 12, thoughtTokens: 3, totalTokens: 9299, cost: 0 }, 'cached prompt tokens count as prompt');
  const auth = 'Basic ' + Buffer.from('opencode:oc-pass').toString('base64');
  assert.equal(fetch.sessions.length, 1);
  assert.equal(fetch.sessions[0].url, OC + '/api/session');
  assert.equal(fetch.sessions[0].auth, auth);
  assert.deepEqual(fetch.sessions[0].body, { title: 'blueflare-ai', agent: 'plan', model: { providerID: 'opencode', id: 'big-pickle' } }, 'the stock agent, permissions untouched');
  const call = fetch.calls[0];
  assert.equal(call.url, OC + '/api/session/ses_1/generate');
  assert.equal(call.auth, auth);
  assert.deepEqual(call.body, { prompt: 'Be brief.\n\nhello' }, 'nothing OpenRouter-only, no reasoning or max_tokens');
  await ai.chat('SAMPLE', user('again'));
  assert.equal(fetch.sessions.length, 1, 'the session is reused');
  assert.equal(fetch.calls[1].url, OC + '/api/session/ses_1/generate');
  assert.equal(call.init.headers['x-title'], undefined);
  assert.deepEqual(ai.modelsFor('SAMPLE').map((m) => m.provider + ':' + m.model), ['opencode:opencode/big-pickle', 'opencode:opencode/glm-5.3-flash-free', 'openrouter:or/m']);

  // Several turns are labelled; an id without a provider part is not an opencode model.
  const { ai: multi, fetch: f } = make(ocEnv({ OPENCODE_MODEL_SAMPLE: 'bare,opencode/x' }), () => ocAnswer('ok'));
  assert.deepEqual(multi.modelsFor('SAMPLE').filter((m) => m.provider === 'opencode').map((m) => m.model), ['opencode/x']);
  await multi.chat('SAMPLE', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.equal(f.calls[0].body.prompt, 'USER:\na\n\nASSISTANT:\nb\n\nUSER:\nc');
  assert.deepEqual(f.sessions[0].body.model, { providerID: 'opencode', id: 'x' });

  // JSON is asked for in the prompt (no response_format), with the schema when there is one.
  const { ai: j, fetch: fj } = make(ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/x' }), () => ocAnswer('```json\n{"ok":true}\n```'));
  const out = await j.json('SAMPLE', [{ role: 'system', content: 'You rank.' }, ...user('x')], { schema: { type: 'object', required: ['ok'] } });
  assert.deepEqual(out.data, { ok: true });
  assert.equal(out.format, 'none');
  assert.match(fj.calls[0].body.prompt, /^You rank\.\n\nAnswer with a single valid JSON value only[\s\S]*JSON schema[\s\S]*\n\nx$/);
  assert.equal(fj.calls[0].body.response_format, undefined);
});

test('b) a gone opencode session is made again once; a failed session creation is handled like an answer', async () => {
  let gone = true;
  const { ai, fetch } = make(ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/x', OPENROUTER_MODEL_SAMPLE: 'or/m' }), (call) => {
    if (call.url.endsWith('/ses_1/generate') && gone) { gone = false; return { status: 404, body: { _tag: 'SessionNotFoundError', sessionID: 'ses_1', message: 'Session not found: ses_1' } }; }
    return reply(call, 'ok');
  });
  const r = await ai.chat('SAMPLE', user('x'));
  assert.equal(r.provider, 'opencode');
  assert.deepEqual(fetch.calls.map((c) => c.url.slice(OC.length)), ['/api/session/ses_1/generate', '/api/session/ses_2/generate']);

  for (const [label, out, reason] of [
    ['401', { status: 401, body: { _tag: 'UnauthorizedError', message: 'Authentication required' } }, 'http 401 (key rejected)'],
    ['no id', { status: 200, body: { data: {} } }, 'http 502'],
    ['down', { status: 503, body: {} }, 'http 503']
  ]) {
    const { ai: bad } = make(ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/x', OPENROUTER_MODEL_SAMPLE: 'or/m', AI_RETRIES: '0' }), (call) => (call.url.endsWith('/api/session') ? out : answer('ok')), {}, { sessions: true });
    const res = await bad.chat('SAMPLE', user('x'));
    assert.equal(res.provider, 'openrouter', label);
    assert.equal(res.attempts[0].reason, reason, label);
  }
});

test('b) session generate: "Free usage limit reached" parks opencode for AI_COOLDOWN_MS, "Model unavailable" parks the model', async () => {
  const vars = ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/big-pickle,opencode/other', OPENROUTER_MODEL_SAMPLE: 'or/m' });
  const { ai, fetch, warnings } = make(vars, (call) => (isOc(call) ? ocBusy('Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go') : answer('ok')));
  const r = await ai.chat('SAMPLE', user('x'));
  assert.deepEqual(r.attempts.map((a) => a.reason), ['http 429 (free allowance used up)', 'ok']);
  assert.equal(fetch.calls.filter(isOc).length, 1, 'the other opencode model is not tried');
  assert.ok(warnings.some((w) => /opencode k1 \([0-9a-f]{6}\) free allowance used up .*parked until 2026-10-07T13:00:00\.000Z/.test(w)));
  await ai.chat('SAMPLE', user('x'));
  assert.equal(fetch.calls.filter(isOc).length, 1);

  const { ai: gone, warnings: w2 } = make(vars, (call) => (isOc(call) && call.url.includes('/ses_1/') ? ocBusy('Model unavailable: opencode/big-pickle') : reply(call, 'ok')));
  const r2 = await gone.chat('SAMPLE', user('x'));
  assert.equal(r2.model, 'opencode/other');
  assert.deepEqual(r2.attempts.map((a) => a.reason), ['http 404 (model unavailable)', 'ok']);
  assert.ok(w2.some((w) => /opencode model opencode\/big-pickle unavailable/.test(w)));
  // Any other ServiceUnavailableError is a 503: retried, then the next pair.
  const { ai: busy, fetch: fb } = make(vars, (call) => (isOc(call) ? ocBusy('database is locked') : answer('ok')));
  assert.equal((await busy.chat('SAMPLE', user('x'))).provider, 'openrouter');
  assert.equal(fb.calls.filter((c) => c.url.includes('/ses_1/')).length, 3);
});

test('b) opencode rate limit / overload / provider error / 5xx falls back to OpenRouter and parks the pair', async () => {
  for (const [label, out, calls] of [['rate_limit', ocFail('rate_limit', { status: 429, retryAfterMs: 2000 }), 3], ['overloaded', ocFail('overloaded'), 3], ['provider', ocFail('provider'), 3], ['503', { status: 503, body: {} }, 3]]) {
    const { ai, fetch } = make(ocEnv({ OPENROUTER_MODEL_SAMPLE: 'or/model', OPENCODE_MODEL_SAMPLE: 'opencode/big-pickle' }), (call) => (isOc(call) ? out : answer('ok', orUsage)));
    const result = await ai.chat('SAMPLE', user('hi'));
    assert.equal(result.provider, 'openrouter', label);
    assert.equal(result.model, 'or/model');
    assert.equal(fetch.calls.filter(isOc).length, calls, 'bounded retries on the same pair for ' + label);
    assert.equal(fetch.calls.at(-1).auth, 'Bearer or-key');
    fetch.calls.length = 0;
    await ai.chat('SAMPLE', user('again'));
    assert.equal(fetch.calls.filter(isOc).length, 0, 'parked after ' + label);
  }
  // An unknown model is parked as unavailable; a content filter is a refusal of this input.
  const { ai: gone, warnings } = make(ocEnv({ OPENROUTER_MODEL_SAMPLE: 'or/m', OPENCODE_MODEL_SAMPLE: 'opencode/nope' }), (call) => (isOc(call)
    ? { status: 404, body: { _tag: 'ModelNotFoundError', providerID: 'opencode', modelID: 'nope', message: 'Model not found: opencode/nope' } } : answer('ok')));
  assert.deepEqual((await gone.chat('SAMPLE', user('x'))).attempts.map((a) => a.reason), ['http 404 (model unavailable)', 'ok']);
  assert.ok(warnings.some((w) => /opencode model opencode\/nope unavailable/.test(w)));
  const { ai: filtered } = make(ocEnv({ OPENROUTER_MODEL_SAMPLE: 'or/m', OPENCODE_MODEL_SAMPLE: 'opencode/x' }), (call) => (isOc(call) ? ocFail('content_filter') : answer('ok')));
  assert.deepEqual((await filtered.chat('SAMPLE', user('x'))).attempts.map((a) => a.reason), ['refused: http 403', 'ok']);
});

test('b) a spent opencode free allowance parks every opencode model until retryAfterMs', async () => {
  const message = 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';
  const vars = ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/big-pickle,opencode/glm-5.3-flash-free', OPENROUTER_MODEL_SAMPLE: 'or/m' });
  const { ai, fetch, warnings } = make(vars, (call) => (isOc(call) ? ocFail('rate_limit', { status: 429, message, retryAfterMs: 9 * 3600 * 1000 }) : answer('ok')));
  const r = await ai.chat('SAMPLE', user('x'));
  assert.equal(r.provider, 'openrouter');
  assert.deepEqual(r.attempts.map((a) => a.reason), ['http 429 (free allowance used up)', 'ok']);
  assert.equal(fetch.calls.filter(isOc).length, 1, 'the second opencode model is not tried');
  assert.ok(warnings.some((w) => /opencode k1 \([0-9a-f]{6}\) free allowance used up .*parked until 2026-10-07T21:00:00\.000Z/.test(w)));
  await ai.chat('SAMPLE', user('x'));
  assert.equal(fetch.calls.filter(isOc).length, 1, 'no probe before the reset');
  assert.ok(warnings.every((w) => !w.includes('oc-pass')), 'the password never reaches a log line');
});

test('b) a 401 (sidecar password or opencode login) and a network error / timeout also fall through, and a 429 retry can succeed', async () => {
  const vars = ocEnv({ OPENCODE_MODEL_SAMPLE: 'opencode/x', OPENROUTER_MODEL_PRIMARY: 'or/model' });
  for (const out of [{ status: 401, body: { _tag: 'UnauthorizedError', message: 'Authentication required' } }, ocFail('authentication')]) {
    const { ai, warnings } = make(vars, (call) => (isOc(call) ? out : answer('ok')));
    assert.equal((await ai.chat('SAMPLE', user('x'))).provider, 'openrouter');
    assert.ok(warnings.some((w) => /opencode k1 \([0-9a-f]{6}\) disabled/.test(w)));
    assert.ok(warnings.every((w) => !w.includes('oc-pass')), 'the password never reaches a log line');
  }
  const { ai: dead } = make(env({ OPENROUTER_API_KEY: 'bad-or-key', OPENROUTER_MODEL_SAMPLE: 'a/one,b/two' }), () => ({ status: 401, body: {} }));
  const err = await dead.chat('SAMPLE', user('x')).catch((e) => e);
  assert.ok(err instanceof AiError && err.blocked, 'every key rejected = unavailable');
  assert.ok(!JSON.stringify({ m: err.message, a: err.attempts }).includes('bad-or-key'), 'keys never reach an error');

  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const { ai: flaky } = make(vars, (call) => (isOc(call) ? timeout : answer('ok')));
  const r = await flaky.chat('SAMPLE', user('x'));
  assert.deepEqual(r.attempts.map((a) => a.reason), ['timeout', 'ok']);

  let n = 0;
  const { ai: retry } = make(vars, (call) => (isOc(call) && ++n === 1 ? ocFail('rate_limit', { status: 429, retryAfterMs: 1000 }) : reply(call, 'ok')));
  assert.equal((await retry.chat('SAMPLE', user('x'))).provider, 'opencode');
});

test('c) the OpenRouter body has usage, reasoning and its headers; usage/cost may be absent', async () => {
  const { ai, fetch } = make(env({ OPENROUTER_MODEL_PRIMARY: 'or/m' }), () => answer('ok', orUsage));
  const result = await ai.chat('SAMPLE', user('hi'), { reasoning: 'high', maxTokens: 100 });
  const or = fetch.calls[0];
  assert.deepEqual(or.body.usage, { include: true });
  assert.deepEqual(or.body.reasoning, { effort: 'high' });
  assert.equal(or.body.max_tokens, 100);
  assert.equal(or.body.temperature, 0);
  assert.equal(or.init.headers['x-title'], 'FilmBluesia');
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, thoughtTokens: 2, totalTokens: 15, cost: 0.0001 });

  const { ai: ok } = make(env({ OPENROUTER_MODEL_PRIMARY: 'or/m' }), () => answer('ok'));
  assert.equal((await ok.chat('SAMPLE', user('hi'))).usage, null);
  const { ai: noCost } = make(env({ OPENROUTER_MODEL_PRIMARY: 'or/m' }), () => answer('ok', { usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  assert.equal((await noCost.chat('SAMPLE', user('hi'))).usage.cost, null);

  // reasoning mapping on OpenRouter.
  for (const [value, field] of [['off', { enabled: false }], [{ maxTokens: 512 }, { max_tokens: 512 }], [{ maxTokens: 0 }, { enabled: false }]]) {
    const { ai: r, fetch: f } = make(env({ OPENROUTER_MODEL_SAMPLE: 'or/m' }), () => answer('ok'));
    await r.chat('SAMPLE', user('x'), { reasoning: value });
    assert.deepEqual(f.calls[0].body.reasoning, field);
  }
  await assert.rejects(ok.chat('SAMPLE', user('x'), { reasoning: 'max' }), TypeError);
});

test('d) bad JSON moves to the next pair; when every pair fails AiError lists every reason', async () => {
  const vars = ocEnv({ OPENCODE_MODEL_MATCH: 'opencode/deep', OPENROUTER_MODEL_MATCH: 'or/a,or/b' });
  const { ai } = make(vars, (call) => reply(call, call.body.model === 'or/b' ? '```json\n{"results":[1]}\n```' : 'not json at all'));
  const good = await ai.json('MATCH', user('rank'));
  assert.deepEqual(good.data, { results: [1] });
  assert.deepEqual(good.attempts.map((a) => a.model + ':' + a.reason.split(':')[0]), ['opencode/deep:bad JSON', 'or/a:bad JSON', 'or/b:ok']);

  const { ai: bad } = make(vars, (call) => (isOc(call) ? ocAnswer('{"oops"') : call.body.model === 'or/a' ? { status: 400, body: { error: { message: 'bad request' } } } : { status: 200, body: '' }));
  const error = await bad.json('MATCH', user('rank')).catch((e) => e);
  assert.ok(error instanceof AiError);
  assert.equal(error.kind, 'content');
  assert.equal(error.permanent, true);
  assert.deepEqual(error.attempts.map((a) => a.provider + '/' + a.model), ['opencode/opencode/deep', 'openrouter/or/a', 'openrouter/or/a', 'openrouter/or/b']);
  assert.match(error.message, /bad JSON/);
  assert.match(error.message, /empty or non-JSON body/);

  // Schema failure and a throwing accept() are refusals too; parsed value comes from accept().
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
  const { ai: s } = make(vars, (call) => reply(call, call.body.model === 'or/b' ? '{"n": 2}' : '{"n": "two"}'));
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
  const vars = ocEnv({ OPENCODE_MODEL_POSTER_TEST: 'opencode/x', OPENROUTER_MODEL_POSTER_TEST: 'text-only,seeing,or/blind,or/eyes' });
  const respond = (call) => {
    if (call.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'or/blind', architecture: { input_modalities: ['text'] } }, { id: 'or/eyes', architecture: { input_modalities: ['text', 'image'] } }] } };
    if (call.body.model === 'text-only') return { status: 400, body: { error: { message: 'This model does not support image input' } } };
    if (call.body.model === 'seeing') return { status: 503, body: {} };
    return answer('a poster');
  };
  const { ai, fetch } = make(vars, respond);
  assert.ok(!ai.modelsFor('POSTER_TEST').some((m) => m.provider === 'opencode'), 'opencode takes text only: no route for a vision role');
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
  assert.ok(!fetch.calls.some(isOc));
  // A non-vision role refuses images outright.
  await assert.rejects(ai.chat('SAMPLE', messages), TypeError);
  assert.throws(() => imagePart(Buffer.from('nope')), TypeError);
});

test('f) response_format downgrades json_schema -> json_object -> none and remembers per provider+model', async () => {
  const schema = { type: 'object', required: ['ok'] };
  const vars = env({ OPENROUTER_MODEL_MATCH: 'or/x' });
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
  // No defaultOc and no OPENCODE_MODEL_*: no opencode route even with the sidecar configured.
  assert.deepEqual(make(ocEnv(), () => answer('x')).ai.modelsFor('SUMMARY_TEST'), [{ provider: 'openrouter', model: 'vendor/summary:free' }]);
  const { ai: own } = make(ocEnv({ OPENCODE_MODEL_PRIMARY: 'opencode/p1', OPENCODE_MODEL_SUMMARY_TEST: 'opencode/mine' }), () => answer('x'));
  assert.deepEqual(own.modelsFor('SUMMARY_TEST'), [{ provider: 'opencode', model: 'opencode/mine' }, { provider: 'openrouter', model: 'vendor/summary:free' }]);
  const { ai: shared } = make(ocEnv({ OPENCODE_MODEL_PRIMARY: 'opencode/p1,opencode/p2', OPENROUTER_MODEL_PRIMARY: 'or/shared' }), () => answer('x'));
  assert.deepEqual(shared.modelsFor('SUMMARY_TEST').map((m) => m.model), ['opencode/p1', 'opencode/p2', 'or/shared']);
  await assert.rejects(ai.chat('NOT_A_ROLE', user('x')), /unknown AI role/);
});

test('h) OPENCODE_URL without OPENCODE_SERVER_PASSWORD fails at startup; the removed primary-provider env only warns', () => {
  assert.throws(() => readAiConfig({ OPENCODE_URL: OC }), (e) => e instanceof AiConfigError && /OPENCODE_SERVER_PASSWORD is required when OPENCODE_URL is set/.test(e.message));
  assert.throws(() => createAi({ env: { OPENCODE_URL: OC, OPENCODE_SERVER_PASSWORD: ' ' } }), AiConfigError);
  assert.throws(() => readAiConfig({ OPENCODE_URL: 'not a url', OPENCODE_SERVER_PASSWORD: 'p' }), /not a valid URL/);
  const cfg = readAiConfig({ OPENCODE_URL: OC + '//', OPENCODE_SERVER_PASSWORD: 'p' });
  assert.equal(cfg.opencode.baseUrl, OC);
  assert.equal(cfg.opencode.name, 'opencode');
  assert.equal(readAiConfig({}).opencode, null);
  const warnings = [];
  const old = readAiConfig({ LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'secret-k', MODEL_PRIMARY: 'deep', MODEL_MATCH: 'x', OPENROUTER_API_KEY: 'or' }, { warn: (m) => warnings.push(m) });
  assert.equal(old.primary, undefined);
  for (const name of ['LLM_BASE_URL', 'LLM_API_KEY', 'MODEL_PRIMARY', 'MODEL_MATCH']) assert.ok(warnings.some((w) => w.includes(name + ' is no longer read')), name);
  assert.ok(warnings.every((w) => !w.includes('secret-k')));
});

test('deprecated names still work and warn once at startup; new names win', () => {
  const warnings = [];
  const cfg = readAiConfig({
    OPENROUTER_API_KEYS: 'a,b', OPENROUTER_MATCH_MODELS: 'old/m', OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS: '500', AI_PAID_DAILY_OUTPUT_TOKENS_MATCH: '700', TMDB_MATCH_AI_TIMEOUT_MS: '90000', OPENROUTER_BASE_URL: 'https://or.example/v1/',
    TMDB_MATCH_AI_RESERVE_PCT: '20', OPENROUTER_COOLDOWN_MS: ''
  }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(cfg.openrouter.keys, ['a', 'b']);
  assert.equal(cfg.openrouter.baseUrl, 'https://or.example/v1');
  assert.equal(cfg.view.OPENROUTER_MODEL_MATCH, 'old/m');
  assert.equal(cfg.view.AI_PAID_DAILY_OUTPUT_TOKENS_MATCH, '700');
  assert.equal(cfg.view.AI_TIMEOUT_MS_MATCH, '90000');
  assert.ok(warnings.some((w) => /OPENROUTER_API_KEYS is deprecated, rename it to OPENROUTER_API_KEY/.test(w)));
  assert.ok(warnings.some((w) => /OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS is deprecated and ignored because AI_PAID_DAILY_OUTPUT_TOKENS_MATCH/.test(w)));
  assert.ok(warnings.some((w) => /TMDB_MATCH_AI_RESERVE_PCT is no longer read/.test(w)));
  assert.ok(!warnings.some((w) => /OPENROUTER_COOLDOWN_MS/.test(w)), 'empty legacy values are silent');
  assert.ok(!warnings.some((w) => /\ba,b\b/.test(w)));
  assert.equal(readAiConfig({}, { warn: () => assert.fail('no warning without legacy names') }).deprecated.length, 0);
});

test('timeouts: call > AI_TIMEOUT_MS_<ROLE> > AI_TIMEOUT_MS > role default; AI_MAX_TOKENS default', async () => {
  const { ai, fetch } = make(env({ OPENROUTER_MODEL_PRIMARY: 'm' }), () => answer('ok'));
  await ai.chat('SAMPLE', user('x'));
  assert.equal(fetch.calls[0].body.max_tokens, 8192);
  const { roleTimeoutMs } = await import('../src/ai/config.js');
  assert.equal(roleTimeoutMs(readAiConfig({}), 'MATCH'), 180000);
  assert.equal(roleTimeoutMs(readAiConfig({}), 'SAMPLE'), 60000);
  assert.equal(roleTimeoutMs(readAiConfig({ AI_TIMEOUT_MS: '30000' }), 'MATCH'), 30000);
  assert.equal(roleTimeoutMs(readAiConfig({ AI_TIMEOUT_MS: '30000', AI_TIMEOUT_MS_MATCH: '200000' }), 'MATCH'), 200000);
  const { ai: m, fetch: f } = make(env({ OPENROUTER_MODEL_PRIMARY: 'm', AI_MAX_TOKENS: '1000' }), () => answer('ok'));
  await m.chat('SAMPLE', user('x'));
  assert.equal(f.calls[0].body.max_tokens, 1000);
});

test('onCall sees every attempt; the ledger enforces the paid cap per role and counts per key+model', async () => {
  let t = Date.UTC(2026, 9, 7, 12);
  const ledger = createQuotaLedger({ now: () => t, warn: () => {} });
  const records = [];
  const vars = env({ OPENROUTER_MODEL_SAMPLE: 'p/paid,f/free:free:0', AI_PAID_DAILY_OUTPUT_TOKENS_SAMPLE: '1000' });
  const { ai, fetch } = make(vars, () => answer('ok', { usage: { prompt_tokens: 10, completion_tokens: 600 } }), { ledger, now: () => t, onCall: (r) => records.push(r) });
  await ai.chat('SAMPLE', user('a'));
  await ai.chat('SAMPLE', user('b'));
  await ai.chat('SAMPLE', user('c'));
  assert.deepEqual(fetch.calls.map((c) => c.body.model), ['p/paid', 'p/paid', 'f/free:free'], 'paid model stops at the cap, :free keeps serving');
  assert.equal(ai.paidTokensToday('SAMPLE'), 1200);
  assert.equal(records.length, 3);
  assert.deepEqual(Object.keys(records[0]).sort(), ['completionTokens', 'cost', 'error', 'key', 'latencyMs', 'model', 'ok', 'promptTokens', 'provider', 'role', 'status', 'thoughtTokens']);
  assert.equal(records[0].role, 'SAMPLE');
  assert.equal(records[0].ok, true);
  t += 86400000;
  fetch.calls.length = 0;
  await ai.chat('SAMPLE', user('d'));
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
  const { ai } = make(env({ OPENROUTER_MODEL_SAMPLE: 'a,b' }), (call) => (call.body.model === 'a'
    ? { status: 200, body: { choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] } }
    : answer('tiếng 中文')));
  const error = await ai.chat('SAMPLE', user('x'), { accept: (text) => { if (/[一-鿿]/.test(text)) throw Object.assign(new Error('stray CJK'), { permanent: true }); return text; } }).catch((e) => e);
  assert.equal(error.kind, 'content');
  assert.deepEqual(error.attempts.map((a) => a.reason), ['refused: content_filter', 'rejected: stray CJK']);
  const { ai: none } = make({}, () => answer('x'));
  assert.equal(none.available('SAMPLE'), false);
  assert.equal((await none.chat('SAMPLE', user('x')).catch((e) => e)).kind, 'unavailable');
});

test('AI_FAKE=1 answers without network or keys', async () => {
  const ai = createAi({ env: { AI_FAKE: '1' } });
  assert.equal(ai.available('MATCH'), true);
  assert.equal((await ai.json('MATCH', user('x'))).data.fake, true);
  assert.equal((await ai.chat('SAMPLE', user('hello'))).text, 'fake: hello');
  const swapped = createAi({ env: env({ OPENROUTER_MODEL_PRIMARY: 'm' }), transport: fakeTransport() });
  assert.equal((await swapped.chat('SAMPLE', user('hi'))).text, 'fake: hi');
});

test('util: models, JSON extraction, schema subset', () => {
  assert.deepEqual(parseModels('a/b:free, c:10:500, a/b:free'), [{ id: 'a/b:free', rpm: 20 }, { id: 'c', rpm: 10, rpd: 500 }]);
  assert.deepEqual(parseModels('deep:free', { freeRpm: 0 }), [{ id: 'deep:free', rpm: 0 }]);
  for (const id of ['a/b:free', 'opencode/glm-5.3-flash-free', 'openrouter/free', 'opencode/big-pickle']) assert.equal(isFree(id), true, id);
  for (const id of ['opencode/claude-haiku-5-5', 'opencode/big-pickle-pro', 'a/b']) assert.equal(isFree(id), false, id);
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

test('AI_REASONING overrides the caller on OpenRouter; opencode gets no reasoning field', async () => {
  const { createAi } = await import('../src/ai/index.js');
  const seen = [];
  const transport = async (url, init) => {
    if (url.endsWith('/api/session')) return new Response(JSON.stringify({ data: { id: 'ses_1' } }), { status: 200 });
    seen.push({ url, body: JSON.parse(init.body) });
    if (seen.length === 1) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ai = createAi({ env: { OPENCODE_URL: OC, OPENCODE_SERVER_PASSWORD: 'p', OPENCODE_MODEL_SAMPLE: 'opencode/m', OPENROUTER_API_KEY: 'o', OPENROUTER_MODEL_SAMPLE: 'x/y', AI_REASONING: 'medium', AI_RETRIES: '0' }, transport, sleep: async () => {}, warn: () => {} });
  await ai.chat('SAMPLE', [{ role: 'user', content: 'hi' }], { reasoning: 'off' });
  assert.deepEqual(Object.keys(seen[0].body), ['prompt']);
  assert.deepEqual(seen[1].body.reasoning, { effort: 'medium' });
  assert.throws(() => createAi({ env: { AI_REASONING: 'huge' }, transport, warn: () => {} }), /AI_REASONING/);
});

test('DEDUPE borrows the MATCH models and keys unless it names its own, with its own paid cap', async () => {
  const { roleRoutes, rolePaidCap } = await import('../src/ai/config.js');
  const borrowed = readAiConfig({ OPENCODE_URL: OC, OPENCODE_SERVER_PASSWORD: 'k', OPENCODE_MODEL_MATCH: 'opencode/deep', OPENROUTER_API_KEY: 'or', OPENROUTER_MODEL_MATCH: 'or/m' });
  assert.equal(roleRoutes(borrowed, 'DEDUPE').length, 2);
  assert.equal(JSON.stringify(roleRoutes(borrowed, 'DEDUPE').map((r) => r.models)), JSON.stringify(roleRoutes(borrowed, 'MATCH').map((r) => r.models)));
  const own = readAiConfig({ OPENCODE_URL: OC, OPENCODE_SERVER_PASSWORD: 'k', OPENCODE_MODEL_MATCH: 'opencode/deep', OPENCODE_MODEL_DEDUPE: 'opencode/wide', OPENROUTER_API_KEY: 'or' });
  assert.match(JSON.stringify(roleRoutes(own, 'DEDUPE')[0].models), /wide/);
  assert.doesNotMatch(JSON.stringify(roleRoutes(own, 'DEDUPE')[0].models), /deep/);
  const capped = readAiConfig({ OPENROUTER_API_KEY: 'or', AI_PAID_DAILY_OUTPUT_TOKENS_MATCH: '100', AI_PAID_DAILY_OUTPUT_TOKENS_DEDUPE: '7' });
  assert.equal(rolePaidCap(capped, 'DEDUPE'), 7);
  assert.equal(rolePaidCap(capped, 'MATCH'), 100);
});

test('MATCH and DEDUPE default to a 1M paid cap and medium reasoning; env overrides, 0 lifts the cap', async () => {
  const { rolePaidCap, roleReasoning } = await import('../src/ai/config.js');
  const bare = readAiConfig({ OPENROUTER_API_KEY: 'or' });
  for (const role of ['MATCH', 'DEDUPE']) {
    assert.equal(rolePaidCap(bare, role), 1_000_000);
    assert.equal(roleReasoning(bare, role), 'medium');
  }
  assert.equal(rolePaidCap(bare, 'SAMPLE'), null);
  assert.equal(roleReasoning(bare, 'SAMPLE'), null);
  const set = readAiConfig({ OPENROUTER_API_KEY: 'or', AI_PAID_DAILY_OUTPUT_TOKENS_DEDUPE: '0', AI_REASONING: 'off', AI_REASONING_MATCH: 'high' });
  assert.equal(rolePaidCap(set, 'DEDUPE'), null);
  assert.equal(rolePaidCap(set, 'MATCH'), 1_000_000);
  assert.equal(roleReasoning(set, 'MATCH'), 'high');
  assert.equal(roleReasoning(set, 'DEDUPE'), 'off');
});

test('openrouter/free counts as a free model', () => {
  assert.equal(isFree('openrouter/free'), true);
  assert.equal(isFree('vendor/model:free'), true);
  assert.equal(isFree('deepseek/deepseek-v4.1-flash-free'), true);
  assert.equal(isFree('deepseek/deepseek-v4.1-flash'), false);
  assert.equal(isFree('openai/gpt-6-luna'), false);
  assert.deepEqual(parseModels('openrouter/free:20:300'), [{ id: 'openrouter/free', rpm: 20, rpd: 300 }]);
});
