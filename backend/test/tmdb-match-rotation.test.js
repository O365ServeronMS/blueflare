import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchBlockedError, createTmdbMatchRotation, tmdbMatchAiAvailable } from '../src/tmdbMatchRotation.js';
import { chatText } from '../src/openrouter.js';

const KEY = 'sk-or-v1-match-secret';
const settings = {
  tmdbMatchAiEnabled: true, openrouterApiKeys: [KEY], openrouterMatchModels: 'a/one:0,b/two:0',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1', tmdbMatchAiTimeoutMs: 1000, openrouterCooldownMs: 1000,
  tmdbMatchAiTransientParkMs: 1000, tmdbMatchAiTransientParkMaxMs: 2000};
const reply = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  text: async () => JSON.stringify(body)
});
const answer = (text) => ({ choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { total_tokens: 5 } });
const run = (call) => call({ text: 'x', buildBody: () => ({ messages: [] }), parse: (json) => chatText(json) });

test('availability: needs the enable flag and a key; otherwise the pass is off', () => {
  assert.equal(tmdbMatchAiAvailable(settings), true);
  assert.equal(tmdbMatchAiAvailable({ ...settings, openrouterApiKeys: [] }), false);
  assert.equal(tmdbMatchAiAvailable({ ...settings, tmdbMatchAiEnabled: false }), false);
  assert.equal(createTmdbMatchRotation({ ...settings, openrouterApiKeys: [] }), null);
  assert.equal(createTmdbMatchRotation({ ...settings, tmdbMatchAiEnabled: false }), null);
  assert.equal(typeof createTmdbMatchRotation(settings), 'function');
});

test('each rotation instance keeps its own state', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    return JSON.parse(init.body).model === 'a/one' ? reply(404, { error: { message: 'No endpoints found' } }) : reply(200, answer('ok'));
  };
  const first = createTmdbMatchRotation(settings, { fetchImpl, warn: () => {}, sleep: async () => {} });
  const second = createTmdbMatchRotation(settings, { fetchImpl, warn: () => {}, sleep: async () => {} });
  assert.equal(await run(first), 'ok');
  assert.equal(await run(first), 'ok'); // a/one is remembered as off in this instance
  assert.deepEqual(seen, ['a/one', 'b/two', 'b/two']);
  assert.equal(await run(second), 'ok');
  assert.equal(seen[3], 'a/one', 'the second instance does not share the first one\'s state');
});

test('every model rejected (401) is a MatchBlockedError and the key never reaches the message', async () => {
  const call = createTmdbMatchRotation(settings, { fetchImpl: async () => reply(401, { error: { message: 'bad key' } }), warn: () => {}, sleep: async () => {} });
  await assert.rejects(run(call), (e) => e instanceof MatchBlockedError && e.blocked === true && !e.message.includes(KEY));
});
