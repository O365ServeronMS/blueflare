import assert from 'node:assert/strict';
import test from 'node:test';
import { allowSummaryFallback, itemModifiedMs, unchangedSlugs } from '../src/syncSkip.js';

const iso = '2026-09-30T03:08:30.000Z';

test('itemModifiedMs reads both kkphim {time} and nguonc string shapes', () => {
  assert.equal(itemModifiedMs({ modified: { time: iso } }), Date.parse(iso));
  assert.equal(itemModifiedMs({ modified: iso }), Date.parse(iso));
  assert.equal(itemModifiedMs({}), null);
  assert.equal(itemModifiedMs({ modified: 'not a date' }), null);
});

test('unchangedSlugs skips only items whose modified time matches the stored one', () => {
  const items = [
    { slug: 'same', modified: { time: iso } },
    { slug: 'newer', modified: { time: '2026-09-30T04:00:00.000Z' } },
    { slug: 'unknown', modified: { time: iso } },
    { slug: 'no-modified' }
  ];
  const stored = [
    { provider_slug: 'same', provider_updated_at: new Date(iso) },
    { provider_slug: 'newer', provider_updated_at: new Date(iso) },
    { provider_slug: 'no-modified', provider_updated_at: new Date(iso) }
  ];
  assert.deepEqual([...unchangedSlugs(items, stored)], ['same']);
});

test('allowSummaryFallback: never over a streamed source; nguonc only refreshes an existing summary row', () => {
  const sets = { goodSlugs: new Set(['good']), streamlessSlugs: new Set(['summary']) };
  assert.equal(allowSummaryFallback('nguonc', 'good', sets), false);
  assert.equal(allowSummaryFallback('nguonc', 'summary', sets), true);
  // a renamed or brand-new nguonc slug whose detail is 404: no new movie from the list item
  assert.equal(allowSummaryFallback('nguonc', 'new-slug', sets), false);
  assert.equal(allowSummaryFallback('kkphim', 'good', sets), false);
  assert.equal(allowSummaryFallback('kkphim', 'new-slug', sets), true);
});
