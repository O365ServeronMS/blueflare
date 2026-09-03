import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessWorkerHeartbeat,
  createWorkerHeartbeat,
  parseWorkerHeartbeat,
  workerHeartbeatTtlSeconds
} from '../src/workerHealth.js';

test('worker heartbeat TTL allows two missed intervals plus recovery time', () => {
  assert.equal(workerHeartbeatTtlSeconds(15 * 60 * 1000), 2100);
});

test('fresh running and retrying worker heartbeats remain live', () => {
  const now = Date.parse('2026-09-03T03:00:00.000Z');
  const heartbeat = createWorkerHeartbeat('degraded', { failure_streak: 1 }, now - 1000);
  const assessment = assessWorkerHeartbeat(heartbeat, 2100000, now);

  assert.equal(assessment.ok, true);
  assert.equal(assessment.ageMs, 1000);
});

test('missing, malformed, stale, and failed heartbeats are not healthy', () => {
  const now = Date.parse('2026-09-03T03:00:00.000Z');
  assert.deepEqual(assessWorkerHeartbeat(null, 1000, now), { ok: false, reason: 'missing' });
  assert.equal(parseWorkerHeartbeat('{not-json'), null);
  assert.equal(
    assessWorkerHeartbeat({ status: 'ok', updated_at: '2026-09-03T02:00:00.000Z' }, 1000, now).reason,
    'stale'
  );
  assert.equal(
    assessWorkerHeartbeat({ status: 'failed', updated_at: '2026-09-03T02:59:59.000Z' }, 1000, now).reason,
    'failed'
  );
});
