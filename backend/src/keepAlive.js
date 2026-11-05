// Node must close an idle socket only after the proxy has stopped reusing it.
// Otherwise Caddy can pick a socket Node has just closed (Node's default
// keepAliveTimeout is 5 s) and answer 502. Caddy is set to `keepalive 30s`
// (infra/scripts/bootstrap-vps.sh) and Node waits 65 s, so Caddy always closes
// first. headersTimeout must stay above keepAliveTimeout, as Node requires.
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

export function applyKeepAlive(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  return server;
}
