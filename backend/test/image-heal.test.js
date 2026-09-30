import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnusableImageSource, planImageHeal } from '../src/imageHeal.js';

const dead = ['phim.nguonc.com'];
const OLD = 'https://phim.nguonc.com/public/images/Post/x.jpg';
const NEW = 'https://img.nguonc.com/images/img-abc.jpg';
const OK = 'https://phimimg.com/uploads/x.webp';

test('empty and dead-host URLs are unusable, others are not', () => {
  assert.equal(isUnusableImageSource(null, dead), true);
  assert.equal(isUnusableImageSource('  ', dead), true);
  assert.equal(isUnusableImageSource(OLD, dead), true);
  assert.equal(isUnusableImageSource('https://sub.phim.nguonc.com/a.jpg', dead), true);
  assert.equal(isUnusableImageSource(NEW, dead), false);
  assert.equal(isUnusableImageSource('not a url', dead), true);
});

test('planImageHeal replaces only broken fields', () => {
  const movie = { thumb_source_url: OLD, poster_source_url: OK };
  assert.deepEqual(planImageHeal(movie, { thumb: NEW, poster: NEW }, dead), { thumb: NEW, poster: null });
});

test('planImageHeal never overwrites a usable URL and returns null when nothing changes', () => {
  const movie = { thumb_source_url: OK, poster_source_url: OK };
  assert.equal(planImageHeal(movie, { thumb: NEW, poster: NEW }, dead), null);
});

test('planImageHeal refuses candidates that are themselves dead or missing', () => {
  const movie = { thumb_source_url: null, poster_source_url: OLD };
  assert.equal(planImageHeal(movie, { thumb: OLD, poster: null }, dead), null);
  assert.deepEqual(planImageHeal(movie, { thumb: NEW, poster: null }, dead), { thumb: NEW, poster: null });
});
