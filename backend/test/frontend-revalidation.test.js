import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRONTEND_REVALIDATE_TAG_LIMIT,
  revalidateFrontend
} from '../src/frontendRevalidation.js';

const URL = 'http://frontend:3000/api/internal/revalidate';
const SECRET = 'test-revalidate-secret';

function accepted(payload) {
  return new Response(JSON.stringify({ ok: true, tags: payload.tags }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('sends every unique valid tag in sequential batches of 32', async () => {
  const requests = [];
  const tags = Array.from({ length: 65 }, (_, index) => 'movie:slug-' + index);
  const stats = await revalidateFrontend([...tags, tags[0], 'INVALID'], {
    url: URL,
    secret: SECRET,
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      requests.push({ url, init, payload });
      return accepted(payload);
    }
  });

  assert.equal(FRONTEND_REVALIDATE_TAG_LIMIT, 32);
  assert.deepEqual(requests.map((request) => request.payload.tags.length), [32, 32, 1]);
  assert.deepEqual(requests.flatMap((request) => request.payload.tags), tags);
  assert.ok(requests.every((request) => request.url === URL));
  assert.ok(requests.every((request) => request.init.headers['x-blueflare-revalidate'] === SECRET));
  assert.ok(requests.every((request) => !request.init.body.includes(SECRET)));
  assert.deepEqual(stats, {
    tags: 65,
    batches: 3,
    succeeded: 3,
    failed: 0,
    declined: null
  });
});

test('continues after one failed batch without logging the secret', async () => {
  const warnings = [];
  let calls = 0;
  const stats = await revalidateFrontend(
    Array.from({ length: 65 }, (_, index) => 'movie:slug-' + index),
    {
      url: URL,
      secret: SECRET,
      fetchImpl: async (url, init) => {
        calls += 1;
        const payload = JSON.parse(init.body);
        return calls === 1
          ? new Response('{}', { status: 503 })
          : accepted(payload);
      },
      logger: { warn: (...parts) => warnings.push(parts.join(' ')) }
    }
  );

  assert.equal(calls, 3);
  assert.equal(stats.succeeded, 2);
  assert.equal(stats.failed, 1);
  assert.match(warnings[0], /batch=1\/3 status=503/);
  assert.ok(warnings.every((warning) => !warning.includes(SECRET)));
});

test('detects a successful response that silently drops tags', async () => {
  const warnings = [];
  const stats = await revalidateFrontend(['home', 'movie:test'], {
    url: URL,
    secret: SECRET,
    fetchImpl: async () => accepted({ tags: ['home'] }),
    logger: { warn: (...parts) => warnings.push(parts.join(' ')) }
  });

  assert.equal(stats.succeeded, 0);
  assert.equal(stats.failed, 1);
  assert.match(warnings[0], /response mismatch batch=1\/1/);
});

test('stands down without a configured secret', async () => {
  let called = false;
  const stats = await revalidateFrontend(['home'], {
    url: URL,
    secret: '',
    fetchImpl: async () => {
      called = true;
      return accepted({ tags: ['home'] });
    }
  });

  assert.equal(called, false);
  assert.equal(stats.declined, 'not-configured');
});
