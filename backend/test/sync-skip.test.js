import assert from 'node:assert/strict';
import test from 'node:test';
import { itemModifiedMs, unchangedSlugs } from '../src/syncSkip.js';

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
