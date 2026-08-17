import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUniqueTmdbMatch } from '../src/tmdb.js';

function hit(overrides = {}) {
  return { id: 1, name: 'Dr. Brain', poster_path: '/p.jpg', backdrop_path: '/b.jpg', ...overrides };
}

test('an unambiguous exact title match is accepted', () => {
  const result = selectUniqueTmdbMatch([hit()], 'Dr. Brain');
  assert.equal(result.status, 'matched');
  assert.equal(result.match.id, 1);
});

test('matching ignores case, punctuation and accents', () => {
  for (const query of ['dr brain', 'DR. BRAIN', 'Dr Brain']) {
    assert.equal(selectUniqueTmdbMatch([hit()], query).status, 'matched', query);
  }
});

test('original_name is matched when the localized name differs', () => {
  const result = selectUniqueTmdbMatch(
    [hit({ name: 'Bác Sĩ Não Bộ', original_name: 'Dr. Brain' })],
    'Dr. Brain'
  );
  assert.equal(result.status, 'matched');
});

// Without a year there is nothing to separate same-named titles, so the only
// safe move is to decline rather than show one title's poster on another.
test('two same-titled candidates are declined as ambiguous', () => {
  const result = selectUniqueTmdbMatch(
    [hit({ id: 1 }), hit({ id: 2 })],
    'Dr. Brain'
  );
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.match, null);
});

test('a near-miss title is not accepted', () => {
  const result = selectUniqueTmdbMatch([hit({ name: 'Dr. Brains Adventure' })], 'Dr. Brain');
  assert.equal(result.status, 'unmatched');
  assert.equal(result.match, null);
});

test('a popular but differently titled top result is never borrowed from', () => {
  const result = selectUniqueTmdbMatch(
    [hit({ name: 'Something Entirely Different', popularity: 999 })],
    'Dr. Brain'
  );
  assert.equal(result.status, 'unmatched');
});

// Artwork is the whole purpose, so an exact match without a poster is useless.
test('an exact match lacking a poster is treated as unmatched', () => {
  const result = selectUniqueTmdbMatch([hit({ poster_path: null })], 'Dr. Brain');
  assert.equal(result.status, 'unmatched');
});

test('a poster-less duplicate does not make a lone valid match ambiguous', () => {
  const result = selectUniqueTmdbMatch(
    [hit({ id: 1 }), hit({ id: 2, poster_path: null })],
    'Dr. Brain'
  );
  assert.equal(result.status, 'matched');
  assert.equal(result.match.id, 1);
});

test('empty results and a blank query are declined without throwing', () => {
  assert.equal(selectUniqueTmdbMatch([], 'Dr. Brain').status, 'unmatched');
  assert.equal(selectUniqueTmdbMatch(undefined, 'Dr. Brain').status, 'unmatched');
  assert.equal(selectUniqueTmdbMatch([hit()], '   ').status, 'unmatched');
});
