// Caddy's reverse_proxy keeps idle upstream connections far longer than Node's
// 5 s default keepAliveTimeout, so it can reuse a socket Node has just closed and
// answer 502. Keep idle sockets open longer than the proxy does, and keep
// headersTimeout above keepAliveTimeout as Node requires.
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

export function applyKeepAlive(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  return server;
}
