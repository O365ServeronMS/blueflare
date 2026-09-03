import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTransientDependencyError,
  retryDelayMs,
  runWorkerLoop
} from '../src/workerLoop.js';

test('recognizes the PostgreSQL timeout that previously terminated the worker', () => {
  assert.equal(isTransientDependencyError(
    new Error('Connection terminated due to connection timeout')
  ), true);
  assert.equal(isTransientDependencyError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientDependencyError(new Error('migration syntax error')), false);
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(7, 1000, 30000), 30000);
});

test('retries a transient startup failure before starting sync cycles', async () => {
  const controller = new AbortController();
  const states = [];
  let initializations = 0;
  let cycles = 0;
  let sleeps = 0;

  await runWorkerLoop({
    initialize: async () => {
      initializations += 1;
      if (initializations === 1) {
        throw new Error('Connection terminated due to connection timeout');
      }
    },
    runCycle: async () => {
      cycles += 1;
      controller.abort();
    },
    writeHeartbeat: async (status, details) => states.push({ status, details }),
    intervalMs: 1000,
    signal: controller.signal,
    sleep: async () => { sleeps += 1; },
    logger: { warn: () => {} }
  });

  assert.equal(initializations, 2);
  assert.equal(cycles, 1);
  assert.equal(sleeps, 2);
  assert.deepEqual(states.map((entry) => entry.status), [
    'starting', 'degraded', 'starting', 'running', 'ok'
  ]);
  assert.equal(states[1].details.stage, 'startup');
});

test('keeps the process alive through a transient cycle failure', async () => {
  const controller = new AbortController();
  const states = [];
  let cycles = 0;

  await runWorkerLoop({
    initialize: async () => {},
    runCycle: async () => {
      cycles += 1;
      if (cycles === 1) throw { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' };
      controller.abort();
    },
    writeHeartbeat: async (status, details) => states.push({ status, details }),
    intervalMs: 1000,
    signal: controller.signal,
    sleep: async () => {},
    logger: { warn: () => {} }
  });

  assert.equal(cycles, 2);
  assert.equal(states.filter((entry) => entry.status === 'degraded').length, 1);
  assert.equal(states.find((entry) => entry.status === 'degraded').details.stage, 'cycle');
  assert.equal(states.at(-1).status, 'ok');
});

test('fails fast and marks heartbeat failed for a non-transient error', async () => {
  const states = [];

  await assert.rejects(
    runWorkerLoop({
      initialize: async () => { throw new Error('migration syntax error'); },
      runCycle: async () => {},
      writeHeartbeat: async (status, details) => states.push({ status, details }),
      intervalMs: 1000,
      logger: { warn: () => {} }
    }),
    /migration syntax error/
  );

  assert.deepEqual(states.map((entry) => entry.status), ['starting', 'failed']);
  assert.equal(states[1].details.stage, 'startup');
});
