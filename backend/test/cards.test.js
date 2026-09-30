import assert from 'node:assert/strict';
import test from 'node:test';
import { CARDS_MAX_SLUGS, cardsCacheKey, parseCardSlugs } from '../src/viewmodels.js';

test('parseCardSlugs dedupes, trims, skips invalid, keeps request order', () => {
  const parsed = parseCardSlugs(' b, a,b,,' + 'x'.repeat(201) + ',c');
  assert.deepEqual(parsed.slugs, ['b', 'a', 'c']);
  assert.deepEqual(parseCardSlugs(null).slugs, []);
});

test('parseCardSlugs rejects more than the cap', () => {
  const many = Array.from({ length: CARDS_MAX_SLUGS + 1 }, (_, i) => 's' + i).join(',');
  assert.equal(parseCardSlugs(many).error, 'too_many_slugs');
  assert.equal(parseCardSlugs(many.split(',').slice(0, CARDS_MAX_SLUGS).join(',')).error, undefined);
});

test('cardsCacheKey ignores order and stays short', () => {
  assert.equal(cardsCacheKey(['a', 'b']), cardsCacheKey(['b', 'a']));
  assert.notEqual(cardsCacheKey(['a']), cardsCacheKey(['b']));
  assert.ok(cardsCacheKey(['x'.repeat(200)]).length < 50);
});
