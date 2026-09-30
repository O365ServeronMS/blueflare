import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySourceFailure, createFailureMemo, ImageSourceError } from '../src/imageSourceFailure.js';

test('classifySourceFailure maps upstream statuses to client responses', () => {
  assert.equal(classifySourceFailure(404).responseStatus, 404);
  assert.equal(classifySourceFailure(410).responseStatus, 404);
  assert.deepEqual(
    [classifySourceFailure(429).responseStatus, classifySourceFailure(429).retryAfterSeconds],
    [503, 60]
  );
  assert.equal(classifySourceFailure(500).responseStatus, 502);
});

test('ImageSourceError keeps the upstream status and legacy message', () => {
  const error = new ImageSourceError(404);
  assert.equal(error.status, 404);
  assert.equal(error.message, 'Image source returned HTTP 404');
});

test('failure memo remembers until the ttl expires and reports first sighting once', () => {
  let time = 1000;
  const memo = createFailureMemo({ now: () => time });
  assert.equal(memo.get('m:a'), null);
  assert.equal(memo.remember('m:a', 429), true);
  assert.equal(memo.remember('m:a', 429), false);
  assert.equal(memo.get('m:a').responseStatus, 503);
  time += 61 * 1000;
  assert.equal(memo.get('m:a'), null);
});

test('failure memo is bounded and evicts the oldest key', () => {
  const memo = createFailureMemo({ max: 2 });
  memo.remember('a', 404);
  memo.remember('b', 404);
  memo.remember('c', 404);
  assert.equal(memo.get('a'), null);
  assert.ok(memo.get('b') && memo.get('c'));
});
