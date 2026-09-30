import assert from 'node:assert/strict';
import test from 'node:test';
import { collectHeroTrending } from '../src/heroTrending.js';

function harness(matchesByPages) {
  const calls = [];
  return {
    calls,
    fetchIds: async ({ pages }) => { calls.push(pages); return Array.from({ length: pages * 20 }, (_, i) => i + 1); },
    resolve: async (ids) => Array.from({ length: matchesByPages(ids.length / 20) })
  };
}

test('does not fetch more pages when the first pass fills the hero', async () => {
  const h = harness(() => 24);
  const result = await collectHeroTrending({ ...h, limit: 24, pages: 3, maxPages: 8 });
  assert.deepEqual(h.calls, [3]);
  assert.equal(result.matches.length, 24);
});

test('widens the candidate window until the hero is full', async () => {
  const h = harness((pages) => (pages >= 5 ? 24 : 23));
  const result = await collectHeroTrending({ ...h, limit: 24, pages: 3, maxPages: 8 });
  assert.deepEqual(h.calls, [3, 5]);
  assert.equal(result.matches.length, 24);
  assert.equal(result.pages, 5);
});

test('stops at maxPages and returns the short result', async () => {
  const h = harness(() => 20);
  const result = await collectHeroTrending({ ...h, limit: 24, pages: 3, maxPages: 8 });
  assert.deepEqual(h.calls, [3, 5, 7, 8]);
  assert.equal(result.matches.length, 20);
});
