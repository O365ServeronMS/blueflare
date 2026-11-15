import assert from 'node:assert/strict';
import test from 'node:test';
import { createAi, AiConfigError, readAiConfig } from '../src/ai/index.js';
import { roleRouteOrder, roleRoutes } from '../src/ai/config.js';

const R9 = 'http://9router:20128/v1';
const OR = 'https://openrouter.ai/api/v1';
const full = (over = {}) => ({
  ROUTER9_BASE_URL: R9, ROUTER9_API_KEY: 'r9-key', OPENROUTER_API_KEY: 'or-key', ...over
});
const cfgOf = (env) => readAiConfig(env, { warn: () => {} });
const order = (env, role) => roleRoutes(cfgOf(env), role).map((r) => r.provider.name);

test('a) without AI_ROUTE: MATCH tries 9router, openrouter; DEDUPE only openrouter', () => {
  assert.deepEqual(order(full(), 'MATCH'), ['9router', 'openrouter']);
  assert.deepEqual(order(full(), 'DEDUPE'), ['openrouter']);
  assert.deepEqual(roleRouteOrder(cfgOf(full()), 'DEDUPE'), ['openrouter']);
});

test('b) AI_ROUTE_DEDUPE sets providers and their order', () => {
  assert.deepEqual(order(full({ AI_ROUTE_DEDUPE: '9router,openrouter' }), 'DEDUPE'), ['9router', 'openrouter']);
  assert.deepEqual(order(full({ AI_ROUTE_DEDUPE: 'openrouter, 9router' }), 'DEDUPE'), ['openrouter', '9router']);
});

test('c) AI_ROUTE applies to roles without their own; AI_ROUTE_<ROLE> wins', () => {
  assert.deepEqual(order(full({ AI_ROUTE: 'openrouter' }), 'MATCH'), ['openrouter']);
  assert.deepEqual(order(full({ AI_ROUTE: 'openrouter', AI_ROUTE_MATCH: '9router' }), 'MATCH'), ['9router']);
  assert.deepEqual(order(full({ AI_ROUTE: '9router' }), 'DEDUPE'), ['9router']); // AI_ROUTE beats the role default
});

test('d) an unknown name or an empty list fails at startup', () => {
  assert.throws(() => cfgOf(full({ AI_ROUTE_MATCH: 'foo' })), AiConfigError);
  assert.throws(() => cfgOf(full({ AI_ROUTE: 'openrouter,foo' })), AiConfigError);
  assert.throws(() => cfgOf(full({ AI_ROUTE_DEDUPE: ' , ' })), AiConfigError);
  assert.throws(() => createAi({ env: full({ AI_ROUTE_MATCH: 'foo' }) }), AiConfigError);
});

test('e) a listed provider without keys leaves the role unavailable', () => {
  const env = { OPENROUTER_API_KEY: 'or-key', AI_ROUTE_DEDUPE: '9router' };
  assert.equal(createAi({ env }).available('DEDUPE'), false);
  assert.equal(createAi({ env }).available('MATCH'), true);
});

test('f) json(DEDUPE) only reaches OpenRouter', async () => {
  const urls = [];
  const transport = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) };
  };
  const ai = createAi({ env: full(), transport, warn: () => {} });
  const result = await ai.json('DEDUPE', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.provider, 'openrouter');
  assert.ok(urls.length > 0 && urls.every((url) => url.startsWith(OR)), urls.join(','));
});

test('g) router9 is an alias of 9router', () => {
  assert.deepEqual(order(full({ AI_ROUTE_DEDUPE: 'router9,openrouter' }), 'DEDUPE'), ['9router', 'openrouter']);
  assert.deepEqual(order(full({ AI_ROUTE_DEDUPE: 'router9,9router' }), 'DEDUPE'), ['9router']);
});

test('h) a leftover `opencode` in AI_ROUTE* is ignored with one startup warning, never an error', () => {
  const warnings = [];
  const cfg = readAiConfig(full({ AI_ROUTE_MATCH: '9router,opencode,openrouter', AI_ROUTE: 'opencode', AI_ROUTE_DEDUPE: 'opencode' }), { warn: (m) => warnings.push(m) });
  assert.deepEqual(roleRoutes(cfg, 'MATCH').map((r) => r.provider.name), ['9router', 'openrouter']);
  // A list naming only opencode counts as unset: AI_ROUTE is also only opencode, so the role default applies.
  assert.deepEqual(roleRoutes(cfg, 'DEDUPE').map((r) => r.provider.name), ['openrouter']);
  for (const name of ['AI_ROUTE_MATCH', 'AI_ROUTE', 'AI_ROUTE_DEDUPE']) assert.equal(warnings.filter((w) => w.includes(name + ' names opencode')).length, 1, name);
  assert.deepEqual(order(full({ AI_ROUTE_MATCH: 'opencode' }), 'MATCH'), ['9router', 'openrouter']);
  assert.doesNotThrow(() => createAi({ env: full({ AI_ROUTE_MATCH: 'opencode' }), warn: () => {} }));
});
