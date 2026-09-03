import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAllowedImageSourceUrl,
  sanitizeMovieImageSources
} from '../src/imageSourcePolicy.js';

test('normalizes only HTTPS URLs from configured image hosts', () => {
  assert.equal(
    normalizeAllowedImageSourceUrl('https://cdn.phimimg.com/poster.webp#fragment'),
    'https://cdn.phimimg.com/poster.webp'
  );
  assert.equal(normalizeAllowedImageSourceUrl('http://phimimg.com/poster.webp'), null);
  assert.equal(normalizeAllowedImageSourceUrl('https://untrusted.example/poster.webp'), null);
});

test('drops only invalid provider artwork and retains canonical movie metadata', () => {
  const { movie, rejected } = sanitizeMovieImageSources({
    provider: 'kkphim',
    providerSlug: 'phu-sa',
    title: 'Phù Sa',
    thumbSourceUrl: 'https://untrusted.example/thumb.webp',
    posterSourceUrl: 'https://phimimg.com/poster.webp'
  });

  assert.equal(movie.title, 'Phù Sa');
  assert.equal(movie.thumbSourceUrl, null);
  assert.equal(movie.posterSourceUrl, 'https://phimimg.com/poster.webp');
  assert.deepEqual(rejected, [{ field: 'thumbSourceUrl', host: 'untrusted.example' }]);
});
