import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTitle,
  slugify,
  mediaFamily,
  titleSimilarity,
  isControlledFuzzyMatch
} from '../src/identity.js';

test('normalizeTitle strips Vietnamese diacritics', () => {
  assert.equal(normalizeTitle('Trọng Khí'), 'trong khi');
  assert.equal(normalizeTitle('Nhân Ngư'), 'nhan ngu');
  assert.equal(normalizeTitle('Người Hùng'), 'nguoi hung');
});

test('normalizeTitle handles đ/Đ substitution', () => {
  assert.equal(normalizeTitle('đường'), 'duong');
  assert.equal(normalizeTitle('Đại Chiến'), 'dai chien');
});

test('normalizeTitle collapses punctuation and whitespace', () => {
  assert.equal(normalizeTitle('  Trọng—Khí! '), 'trong khi');
  assert.equal(normalizeTitle('Hello---World...Test'), 'hello world test');
});

test('normalizeTitle returns empty for empty/null input', () => {
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(undefined), '');
});

test('normalizeTitle handles CJK characters', () => {
  const result = normalizeTitle('重庆 Test');
  assert.ok(result.includes('test'));
  assert.ok(result.length > 4);
});

test('normalizeTitle handles mixed scripts', () => {
  assert.equal(normalizeTitle('Film 2026: Đại Chiến!'), 'film 2026 dai chien');
});

test('slugify produces stable slugs', () => {
  assert.equal(slugify('Trọng Khí'), 'trong-khi');
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify returns movie for empty input', () => {
  assert.equal(slugify(''), 'movie');
  assert.equal(slugify(null), 'movie');
});

test('slugify handles special characters', () => {
  assert.equal(slugify('Test!@#$%Film'), 'test-film');
});

test('mediaFamily recognizes movie types', () => {
  assert.equal(mediaFamily('single'), 'movie');
  assert.equal(mediaFamily('movie'), 'movie');
  assert.equal(mediaFamily('phim-le'), 'movie');
});

test('mediaFamily defaults to tv', () => {
  assert.equal(mediaFamily('series'), 'tv');
  assert.equal(mediaFamily('hoathinh'), 'tv');
  assert.equal(mediaFamily('tvshows'), 'tv');
  assert.equal(mediaFamily(''), 'tv');
  assert.equal(mediaFamily(null), 'tv');
});

test('titleSimilarity returns 1.0 for identical titles', () => {
  assert.equal(titleSimilarity('Hello World', 'Hello World'), 1.0);
});

test('titleSimilarity returns 0 for empty input', () => {
  assert.equal(titleSimilarity('', 'Hello'), 0);
  assert.equal(titleSimilarity('Hello', ''), 0);
  assert.equal(titleSimilarity('', ''), 0);
});

test('titleSimilarity computes correct Dice coefficient', () => {
  const score = titleSimilarity('aaa bbb ccc', 'bbb ccc ddd');
  assert.ok(score > 0.6);
  assert.ok(score < 0.8);
});

test('titleSimilarity is case and diacritic insensitive', () => {
  assert.equal(titleSimilarity('Trọng Khí', 'Trong Khi'), 1.0);
});

test('isControlledFuzzyMatch rejects different years', () => {
  assert.equal(isControlledFuzzyMatch(
    { title: 'Test Movie', original_title: 'Test', year: 2025, media_type: 'movie' },
    { title: 'Test Movie', originalTitle: 'Test', year: 2026, mediaType: 'movie' }
  ), false);
});

test('isControlledFuzzyMatch rejects different media families', () => {
  assert.equal(isControlledFuzzyMatch(
    { title: 'Test', original_title: 'Test', year: 2025, media_type: 'movie' },
    { title: 'Test', originalTitle: 'Test', year: 2025, mediaType: 'series' }
  ), false);
});

test('isControlledFuzzyMatch accepts matching titles with diacritics', () => {
  assert.equal(isControlledFuzzyMatch(
    { title: 'Nhân Ngư', original_title: 'Ren Yu', year: 2026, media_type: 'tv' },
    { title: 'Nhan Ngu', originalTitle: 'Ren Yu', year: 2026, mediaType: 'tv' }
  ), true);
});

test('isControlledFuzzyMatch rejects dissimilar titles', () => {
  assert.equal(isControlledFuzzyMatch(
    { title: 'Completely Different', original_title: 'Film A', year: 2025, media_type: 'movie' },
    { title: 'Another Movie', originalTitle: 'Film B', year: 2025, mediaType: 'movie' }
  ), false);
});

test('isControlledFuzzyMatch returns false for null inputs', () => {
  assert.equal(isControlledFuzzyMatch(null, { title: 'T', originalTitle: 'T', year: 2025, mediaType: 'movie' }), false);
  assert.equal(isControlledFuzzyMatch({ title: 'T', original_title: 'T', year: 2025, media_type: 'movie' }, null), false);
});

test('isControlledFuzzyMatch respects custom threshold', () => {
  const score = titleSimilarity('Film ABC', 'Film ABD');
  const candidate = { title: 'Film ABC', original_title: 'Film ABC', year: 2025, media_type: 'movie' };
  const incoming = { title: 'Film ABD', originalTitle: 'Film ABD', year: 2025, mediaType: 'movie' };
  assert.equal(isControlledFuzzyMatch(candidate, incoming, score - 0.01), true);
  assert.equal(isControlledFuzzyMatch(candidate, incoming, score + 0.01), false);
});
