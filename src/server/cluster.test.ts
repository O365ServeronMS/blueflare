import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBalancer, makeUpstream, pickUpstream } from "./cluster.mjs";

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function request(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fakeWorker(name: string, revalidateStatus = 200) {
  const seen: { method?: string; url?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      const status = req.url === "/api/internal/revalidate" ? revalidateStatus : 200;
      res.writeHead(status, { "content-type": "text/plain", "x-worker": name });
      res.end(name);
    });
  });
  const port = await listen(server);
  const upstream = makeUpstream(port);
  upstream.up = true;
  return { upstream, seen };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("frontend balancer", () => {
  it("picks the least busy live upstream", () => {
    const a = makeUpstream(1);
    const b = makeUpstream(2);
    const c = makeUpstream(3);
    a.up = b.up = true;
    a.inflight = 3;
    b.inflight = 1;
    c.inflight = 0;
    expect(pickUpstream([a, b, c])).toBe(b);
    b.up = false;
    expect(pickUpstream([a, b, c])).toBe(a);
    a.up = false;
    expect(pickUpstream([a, b, c])).toBeNull();
  });

  it("answers 503 when no worker is up", async () => {
    const down = makeUpstream(1);
    const port = await listen(createBalancer([down]));
    const res = await request(port, "GET", "/");
    expect(res.status).toBe(503);
  });

  it("proxies requests with query and headers intact", async () => {
    const worker = await fakeWorker("a");
    const port = await listen(createBalancer([worker.upstream]));
    const res = await request(port, "GET", "/list/phim-le?page=2", undefined, { "x-forwarded-for": "1.2.3.4" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("a");
    expect(worker.seen[0].url).toBe("/list/phim-le?page=2");
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const dead = makeUpstream(1);
    dead.up = true;
    const port = await listen(createBalancer([dead]));
    const res = await request(port, "GET", "/");
    expect(res.status).toBe(502);
  });

  it("replays revalidation to every worker", async () => {
    const a = await fakeWorker("a");
    const b = await fakeWorker("b");
    const port = await listen(createBalancer([a.upstream, b.upstream]));
    const payload = JSON.stringify({ tags: ["home", "movie:x"] });
    const res = await request(port, "POST", "/api/internal/revalidate", payload, { "content-type": "application/json", "x-blueflare-revalidate": "s" });
    expect(res.status).toBe(200);
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
    expect(a.seen[0].body).toBe(payload);
    expect(b.seen[0].body).toBe(payload);
  });

  it("fails revalidation if any worker rejects it", async () => {
    const a = await fakeWorker("a");
    const b = await fakeWorker("b", 401);
    const port = await listen(createBalancer([a.upstream, b.upstream]));
    const res = await request(port, "POST", "/api/internal/revalidate", "{}", { "content-type": "application/json" });
    expect(res.status).toBe(401);
  });

  it("refuses revalidation while a worker is down", async () => {
    const a = await fakeWorker("a");
    const b = makeUpstream(1);
    const port = await listen(createBalancer([a.upstream, b]));
    const res = await request(port, "POST", "/api/internal/revalidate", "{}");
    expect(res.status).toBe(503);
    expect(a.seen).toHaveLength(0);
  });
});
