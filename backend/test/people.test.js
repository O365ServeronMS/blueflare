import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asciiSlugBody,
  creditIdentity,
  normalizeCreditRole,
  personSlug
} from '../src/people.js';

const SLUG_PATTERN = /^[a-z0-9:_-]{1,128}$/;

test('personSlug: ascii name', () => {
  assert.equal(personSlug('Andy Lau', 1337), 'andy-lau-1337');
});

test('personSlug: Vietnamese diacritics and đ fold to ascii', () => {
  assert.equal(personSlug('Lưu Đức Hoa', 1337), 'luu-duc-hoa-1337');
});

test('personSlug: CJK name strips to the id-only fallback', () => {
  const slug = personSlug('千葉繁', 88);
  assert.equal(slug, 'nguoi-88');
  assert.ok(/^[\x00-\x7F]*$/.test(slug), 'slug must not contain non-ASCII characters');
});

test('personSlug: Cyrillic name strips to the id-only fallback', () => {
  assert.equal(personSlug('Ольга', 5), 'nguoi-5');
});

test('personSlug: a placeholder-looking name still slugs normally', () => {
  assert.equal(personSlug('Đang cập nhật', 9), 'dang-cap-nhat-9');
});

test('personSlug: a zero or missing TMDB id yields an empty slug', () => {
  assert.equal(personSlug('Andy Lau', 0), '');
  assert.equal(personSlug('Andy Lau', null), '');
});

test('personSlug: every generated slug matches the revalidation tag pattern', () => {
  const cases = [
    personSlug('Andy Lau', 1337),
    personSlug('Lưu Đức Hoa', 1337),
    personSlug('千葉繁', 88),
    personSlug('Ольга', 5),
    personSlug('Đang cập nhật', 9)
  ];
  for (const slug of cases) {
    assert.match(slug, SLUG_PATTERN, `expected "${slug}" to match ${SLUG_PATTERN}`);
  }
});

test('asciiSlugBody: strips non-ascii letters entirely', () => {
  assert.equal(asciiSlugBody('千葉繁'), '');
});

test('creditIdentity: requires both tmdb_id and a supported tmdb_media_type', () => {
  assert.deepEqual(
    creditIdentity({ tmdb_id: 42, tmdb_media_type: 'tv' }),
    { mediaType: 'tv', tmdbId: 42 }
  );
  assert.deepEqual(
    creditIdentity({ tmdb_id: 7, tmdb_media_type: 'movie' }),
    { mediaType: 'movie', tmdbId: 7 }
  );
});

test('creditIdentity: a guessed tmdb_lookup_id alone is not enough', () => {
  assert.equal(creditIdentity({ tmdb_id: null, tmdb_lookup_id: 99, tmdb_media_type: 'movie' }), null);
});

test('creditIdentity: a guessed tmdb_image_fallback_id alone is not enough', () => {
  assert.equal(
    creditIdentity({ tmdb_id: null, tmdb_image_fallback_id: 13, tmdb_media_type: 'movie' }),
    null
  );
});

test('creditIdentity: an unsupported media type is null even with a tmdb_id', () => {
  assert.equal(creditIdentity({ tmdb_id: 42, tmdb_media_type: 'hoathinh' }), null);
});

test('creditIdentity: no row at all is null', () => {
  assert.equal(creditIdentity(null), null);
});

test('normalizeCreditRole: recognized roles pass through case-insensitively', () => {
  assert.equal(normalizeCreditRole('cast'), 'cast');
  assert.equal(normalizeCreditRole('director'), 'director');
  assert.equal(normalizeCreditRole('CAST'), 'cast');
});

test('normalizeCreditRole: anything else reads as all', () => {
  assert.equal(normalizeCreditRole(''), 'all');
  assert.equal(normalizeCreditRole('xyz'), 'all');
  assert.equal(normalizeCreditRole(undefined), 'all');
});
