import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyKeepAlive, KEEP_ALIVE_TIMEOUT_MS } from '../src/keepAlive.js';

test('api server keeps idle sockets longer than the proxy and Node default', () => {
  const server = applyKeepAlive(http.createServer());
  assert.equal(server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(server.keepAliveTimeout > 5_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});

test('an idle keep-alive socket survives past the old 5 s default', { timeout: 15_000 }, async () => {
  const server = applyKeepAlive(http.createServer((req, res) => res.end('ok')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: true });
  const get = () => new Promise((resolve, reject) => {
    http.get({ port: server.address().port, host: '127.0.0.1', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.socket ?? null));
    }).on('error', reject);
  });
  let closed = 0;
  server.on('connection', (socket) => socket.on('close', () => { closed += 1; }));
  await get();
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  assert.equal(closed, 0);
  agent.destroy();
  await new Promise((resolve) => server.close(resolve));
});
