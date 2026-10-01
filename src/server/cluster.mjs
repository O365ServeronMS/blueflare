import http from "node:http";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";

const REVALIDATE_PATH = "/api/internal/revalidate";
const MAX_REVALIDATE_BODY = 64 * 1024;
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "upgrade"];

function stripHopByHop(headers) {
  const out = { ...headers };
  for (const name of HOP_BY_HOP) delete out[name];
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendBuffered(upstream, req, body) {
  return new Promise((resolve) => {
    const proxyReq = http.request(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers: stripHopByHop({ ...req.headers, "content-length": body.length }), agent: upstream.agent },
      (proxyRes) => {
        const chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => resolve({ status: proxyRes.statusCode || 502, headers: proxyRes.headers, body: Buffer.concat(chunks) }));
        proxyRes.on("error", () => resolve({ status: 502, headers: {}, body: Buffer.from('{"error":"upstream"}') }));
      }
    );
    proxyReq.on("error", () => resolve({ status: 502, headers: {}, body: Buffer.from('{"error":"upstream"}') }));
    proxyReq.end(body);
  });
}

// Next's "use cache" store lives in each process, so a tag expired in one
// worker would stay stale in the others. The revalidation request is
// therefore replayed to every worker and only succeeds if all of them do.
async function fanOutRevalidate(upstreams, req, res) {
  let body;
  try {
    body = await readBody(req, MAX_REVALIDATE_BODY);
  } catch {
    res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
    res.end('{"error":"Payload Too Large"}');
    return;
  }
  const results = await Promise.all(upstreams.map((upstream) => sendBuffered(upstream, req, body)));
  const failed = results.find((result) => result.status < 200 || result.status >= 300);
  const chosen = failed || results[0];
  const headers = stripHopByHop(chosen.headers);
  delete headers["transfer-encoding"];
  headers["content-length"] = chosen.body.length;
  res.writeHead(chosen.status, headers);
  res.end(chosen.body);
}

function proxy(upstream, req, res) {
  upstream.inflight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    upstream.inflight -= 1;
  };
  const proxyReq = http.request(
    { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers: stripHopByHop(req.headers), agent: upstream.agent },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, stripHopByHop(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on("end", release);
      proxyRes.on("error", () => {
        release();
        res.destroy();
      });
    }
  );
  proxyReq.on("error", () => {
    release();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("Bad Gateway");
  });
  res.on("close", () => {
    release();
    proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

export function pickUpstream(upstreams) {
  const up = upstreams.filter((upstream) => upstream.up);
  if (!up.length) return null;
  return up.reduce((best, candidate) => (candidate.inflight < best.inflight ? candidate : best));
}

export function createBalancer(upstreams) {
  return http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    if (req.method === "POST" && path === REVALIDATE_PATH) {
      if (upstreams.some((upstream) => !upstream.up)) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "2" });
        res.end('{"error":"worker restarting"}');
        return;
      }
      void fanOutRevalidate(upstreams, req, res);
      return;
    }
    const upstream = pickUpstream(upstreams);
    if (!upstream) {
      res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store", "retry-after": "2" });
      res.end("No worker available");
      return;
    }
    proxy(upstream, req, res);
  });
}

export function makeUpstream(port, host = "127.0.0.1") {
  return { host, port, up: false, inflight: 0, agent: new http.Agent({ keepAlive: true }) };
}

function waitUntilListening(upstream, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = http.get({ host: upstream.host, port: upstream.port, path: "/healthz", agent: false }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      socket.on("error", () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function main() {
  const count = Math.max(1, Number.parseInt(process.env.FRONTEND_WORKERS || "2", 10) || 2);
  const publicPort = Number.parseInt(process.env.PORT || "3000", 10);
  const basePort = Number.parseInt(process.env.FRONTEND_WORKER_BASE_PORT || String(publicPort + 1), 10);
  const serverEntry = process.env.FRONTEND_SERVER_ENTRY || "server.js";
  const upstreams = Array.from({ length: count }, (_, index) => makeUpstream(basePort + index));
  const children = new Map();
  let stopping = false;

  const start = (index, attempt) => {
    const upstream = upstreams[index];
    const child = fork(serverEntry, [], { env: { ...process.env, PORT: String(upstream.port), HOSTNAME: "127.0.0.1" } });
    children.set(index, child);
    void waitUntilListening(upstream, 60_000).then((ok) => {
      if (ok && children.get(index) === child) upstream.up = true;
    });
    child.on("exit", (code, signal) => {
      upstream.up = false;
      if (stopping) return;
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      console.error(`frontend worker ${index} exited (${signal || code}); restarting in ${delay}ms`);
      setTimeout(() => start(index, attempt + 1), delay).unref?.();
    });
    setTimeout(() => {
      if (upstream.up) attempt = 0;
    }, 30_000).unref();
  };

  upstreams.forEach((_, index) => start(index, 0));

  const server = createBalancer(upstreams);
  server.keepAliveTimeout = 65_000;
  server.listen(publicPort, process.env.HOSTNAME || "0.0.0.0", () => {
    console.log(`frontend balancer on :${publicPort} -> ${count} workers (${basePort}..${basePort + count - 1})`);
  });

  const shutdown = () => {
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
    server.close();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
