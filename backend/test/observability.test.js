import assert from 'node:assert/strict';
import test from 'node:test';
import { metricsSnapshot, observeCache, observeRequest } from '../src/observability.js';

test('observability aggregates bounded route and cache counters', () => {
  observeCache('VALKEY-HIT');
  observeCache('IMAGE-DISK-HIT');
  observeRequest('/api/movie/example', 200, 12);
  observeRequest('/api/movie/another', 503, 30);
  const snapshot = metricsSnapshot();
  assert.equal(snapshot.cache['VALKEY-HIT'] >= 1, true);
  assert.equal(snapshot.cache['IMAGE-DISK-HIT'] >= 1, true);
  assert.equal(snapshot.routes['/api/movie/:slug'].count >= 2, true);
  assert.equal(snapshot.routes['/api/movie/:slug'].errors >= 1, true);
});
