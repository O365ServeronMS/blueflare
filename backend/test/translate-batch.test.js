import test from 'node:test';
import assert from 'node:assert/strict';
import { packBatches, batchUserMessage, parseBatchResponse } from '../src/translateBatch.js';
import { createOpenRouterRotation } from '../src/openrouter.js';

const rev = (n, len) => ({ id: 'r' + n, content: 'x'.repeat(len) });

test('packBatches: respects chars and items, keeps order, never drops a large review', () => {
  const groups = packBatches([rev(1, 3000), rev(2, 3000), rev(3, 3000), rev(4, 100), rev(5, 4000)], { maxChars: 8000, maxItems: 3 });
  assert.deepEqual(groups.map((g) => g.map((r) => r.id)), [['r1', 'r2'], ['r3', 'r4', 'r5']]);
  assert.deepEqual(packBatches([], {}), []);
  assert.deepEqual(packBatches([rev(1, 9000)], { maxChars: 8000 }).map((g) => g.length), [1]);
});

const sources = ['Great movie with a lovely cast and a strong ending.', 'Terrible. I hated every single minute of this film, honestly.'];
const answer = (n, a, b) => `<<<${n}:1>>>\n${a}\n<<<${n}:2>>>\n${b}\n<<<${n}:end>>>`;

test('parseBatchResponse: accepts a well-formed answer', () => {
  assert.match(batchUserMessage(sources, 'ab12'), /^<<<ab12:1>>>\nGreat/);
  const r = parseBatchResponse(answer('ab12', 'Phim hay với dàn diễn viên đáng yêu và cái kết mạnh mẽ.', 'Tệ. Tôi ghét từng phút của bộ phim này, thật lòng.'), sources, 'ab12');
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
});

test('parseBatchResponse: a missing end marker is accepted', () => {
  const a = 'Phim hay với dàn diễn viên đáng yêu và cái kết mạnh mẽ.';
  const b = 'Tệ. Tôi ghét từng phút của bộ phim này, thật lòng.';
  const r = parseBatchResponse(`<<<ab12:1>>>\n${a}\n<<<ab12:2>>>\n${b}`, sources, 'ab12');
  assert.deepEqual(r.items, [a, b]);
});

test('parseBatchResponse: rejects missing/forged/misordered markers, empty, CJK, odd length, extra text', () => {
  const a = 'Phim hay với dàn diễn viên đáng yêu và cái kết mạnh mẽ.';
  const b = 'Tệ. Tôi ghét từng phút của bộ phim này, thật lòng.';
  assert.equal(parseBatchResponse(answer('zzzz', a, b), sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse(`<<<ab12:1>>>\n${a}\n<<<ab12:end>>>`, sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse(`<<<ab12:2>>>\n${a}\n<<<ab12:1>>>\n${b}\n<<<ab12:end>>>`, sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse(answer('ab12', a, ''), sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse(answer('ab12', a, 'Tệ hôn妻 phút của bộ phim này, thật lòng.'), sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse(answer('ab12', a, 'Ừ.'), sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse('Sure! ' + answer('ab12', a, b), sources, 'ab12').ok, false);
  assert.equal(parseBatchResponse(answer('ab12', a, b) + '\nNote: done', sources, 'ab12').ok, false);
});

test('paid token cap: paid models sit out once spent, the free one still serves', async () => {
  const used = { 'f/free:free': 0, 'p/paid': 1500 };
  const ledger = {
    ready: async () => {},
    snapshot: (_k, model) => ({ tokens: used[model] ?? 0 }),
    availability: () => ({ ok: true, rpmAt: 0 }),
    begin: async () => ({}),
    finish: async () => {}
  };
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(JSON.parse(init.body).model);
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ choices: [{ message: { content: 'xin chào' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) };
  };
  const mk = (cap) => createOpenRouterRotation({ apiKeys: ['k'], models: 'p/paid,f/free:free:0', ledger, fetchImpl, paidDailyTokenCap: cap, sleep: async () => {} });
  await mk(1000)({ text: 'hi', buildBody: () => ({ messages: [] }), parse: (j) => j });
  assert.deepEqual(seen, ['f/free:free']);
  seen.length = 0;
  await mk(0)({ text: 'hi', buildBody: () => ({ messages: [] }), parse: (j) => j });
  assert.deepEqual(seen, ['p/paid']);
});
