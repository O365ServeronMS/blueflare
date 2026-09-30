import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientIp, handleAuthCredentials, handleLogout, handleMe, isCloudflareAddress, resolveMePath
} from "@/lib/account-proxy";

const ORIGIN = "https://phim.bluesia.net";
const TOKEN = "t".repeat(43);
const fetchMock = vi.fn();

function req(method: string, url: string, headers: Record<string, string> = {}, body?: string) {
  return new Request(`http://127.0.0.1:3100${url}`, {
    method,
    headers: { host: "phim.bluesia.net", "x-forwarded-proto": "https", ...headers },
    body
  });
}
const sameOrigin = { origin: ORIGIN, "content-type": "application/json" };
const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INTERNAL_CATALOG_URL", "http://api:3200");
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("origin check", () => {
  it("rejects missing and mismatched Origin on writes without calling the API", async () => {
    for (const headers of [{} as Record<string, string>, { origin: "https://evil.example" }, { origin: "http://phim.bluesia.net" }]) {
      const res = await handleAuthCredentials(req("POST", "/api/auth/login", headers, "{}"), "login");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "bad_origin" });
    }
    expect((await handleMe(req("PUT", "/api/me/favorites/x", { cookie: `bf_session=${TOKEN}` }), ["favorites", "x"])).status).toBe(403);
    expect((await handleLogout(req("POST", "/api/auth/logout"))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require Origin on GET", async () => {
    fetchMock.mockResolvedValue(json(200, { user: { id: "1", email: "a@b.c" }, imported: false }));
    const res = await handleMe(req("GET", "/api/me", { cookie: `bf_session=${TOKEN}` }), []);
    expect(res.status).toBe(200);
  });
});

describe("login/register cookie", () => {
  it("sets the session cookie and keeps the token out of the body", async () => {
    const expiresAt = "2026-10-30T00:00:00.000Z";
    fetchMock.mockResolvedValue(json(200, { token: TOKEN, expiresAt, user: { id: "u1", email: "a@b.c" } }));
    const res = await handleAuthCredentials(req("POST", "/api/auth/login", sameOrigin, '{"email":"a@b.c","password":"x"}'), "login");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ user: { id: "u1", email: "a@b.c" } });
    expect(text).not.toContain(TOKEN);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`bf_session=${TOKEN}`);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Expires=Fri, 30 Oct 2026 00:00:00 GMT"]) {
      expect(cookie).toContain(attr);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps 201 and omits Secure outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    fetchMock.mockResolvedValue(json(201, { token: TOKEN, expiresAt: "2026-10-30T00:00:00.000Z", user: { id: "u1", email: "a@b.c" } }));
    const res = await handleAuthCredentials(req("POST", "/api/auth/register", sameOrigin, "{}"), "register");
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("passes errors and Retry-After through without a cookie", async () => {
    fetchMock.mockResolvedValue(json(429, { error: "rate_limited" }, { "retry-after": "120" }));
    const res = await handleAuthCredentials(req("POST", "/api/auth/login", sameOrigin, "{}"), "login");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("passes 503 busy with Retry-After, uncached, on register", async () => {
    fetchMock.mockResolvedValue(json(503, { error: "busy" }, { "retry-after": "5", "cache-control": "public, max-age=60" }));
    const res = await handleAuthCredentials(req("POST", "/api/auth/register", sameOrigin, "{}"), "register");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "busy" });
  });

  it("rejects bodies over 32 KB", async () => {
    const res = await handleAuthCredentials(req("POST", "/api/auth/login", sameOrigin, "x".repeat(33 * 1024)), "login");
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("logout", () => {
  it("calls the API with Bearer, clears the cookie, returns 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await handleLogout(req("POST", "/api/auth/logout", { origin: ORIGIN, cookie: `bf_session=${TOKEN}` }));
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/bf_session=;.*Max-Age=0/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("clears the cookie even when the API is down or there is no cookie", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const res = await handleLogout(req("POST", "/api/auth/logout", { origin: ORIGIN, cookie: `bf_session=${TOKEN}` }));
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    fetchMock.mockClear();
    await handleLogout(req("POST", "/api/auth/logout", { origin: ORIGIN }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/api/me", () => {
  it("returns 401 without a cookie and does not call the API", async () => {
    const res = await handleMe(req("GET", "/api/me"), []);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the cookie when the API answers 401", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "unauthorized" }));
    const res = await handleMe(req("GET", "/api/me/favorites", { cookie: `bf_session=${TOKEN}` }), ["favorites"]);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("strips client-supplied auth and forwarding headers", async () => {
    fetchMock.mockResolvedValue(json(200, { items: [] }));
    await handleMe(req("GET", "/api/me/favorites", {
      cookie: `bf_session=${TOKEN}`,
      authorization: "Bearer attacker",
      forwarded: "for=6.6.6.6",
      "x-forwarded-for": "6.6.6.6, 173.245.48.5",
      "cf-connecting-ip": "203.0.113.9",
      "x-real-ip": "6.6.6.6"
    }), ["favorites"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api:3200/api/me/favorites");
    const names = Object.keys(init.headers).map((n) => n.toLowerCase()).sort();
    expect(names).toEqual(["accept", "authorization", "x-forwarded-for"]);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["X-Forwarded-For"]).toBe("203.0.113.9");
  });

  it("encodes slugs", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const put = await handleMe(req("PUT", "/api/me/favorites/a", { ...sameOrigin, cookie: `bf_session=${TOKEN}` }), ["favorites", "a b/../?x"]);
    expect(put.status).toBe(404);
    const ok = await handleMe(req("PUT", "/api/me/favorites/x", { ...sameOrigin, cookie: `bf_session=${TOKEN}` }), ["favorites", "phim mới?"]);
    expect(ok.status).toBe(204);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://api:3200/api/me/favorites/${encodeURIComponent("phim mới?")}`);
    await handleMe(req("PUT", "/api/me/history/x", { ...sameOrigin, cookie: `bf_session=${TOKEN}` }, '{"serverName":"S","episodeKey":"tap-1","episodeName":"Tập 1"}'), ["history", "x"]);
    expect(fetchMock.mock.calls[1][1].body).toBe('{"serverName":"S","episodeKey":"tap-1","episodeName":"Tập 1"}');
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
  });
});

describe("path allow-list", () => {
  it("accepts only contract shapes", () => {
    expect(resolveMePath([])).toEqual({ path: "/api/me", methods: ["GET"] });
    expect(resolveMePath(["import"])?.methods).toEqual(["POST"]);
    expect(resolveMePath(["history", "abc"])?.methods).toEqual(["PUT"]);
    expect(resolveMePath(["progress"])).toBeNull();
    expect(resolveMePath(["continue-watching"])).toBeNull();
    for (const bad of [
      ["internal", "revalidate"], ["admin"], ["favorites", "a", "b"], ["history", ".."], ["favorites", ""],
      ["import", "x"], ["constructor"], ["__proto__"], ["favorites", "a/b"], ["favorites", "a\nb"]
    ]) expect(resolveMePath(bad), JSON.stringify(bad)).toBeNull();
  });

  it("answers 404 for unknown paths and 405 for wrong methods without calling the API", async () => {
    const cookie = { ...sameOrigin, cookie: `bf_session=${TOKEN}` };
    expect((await handleMe(req("GET", "/x", cookie), ["internal", "revalidate"])).status).toBe(404);
    const res = await handleMe(req("DELETE", "/x", cookie), ["favorites"]);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("client ip", () => {
  it("trusts CF-Connecting-IP only when the Caddy-written peer is Cloudflare", () => {
    expect(clientIp(req("GET", "/", { "x-forwarded-for": "173.245.48.5", "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(req("GET", "/", { "x-forwarded-for": "2606:4700::1", "cf-connecting-ip": "2001:db8::5" }))).toBe("2001:db8::5");
    expect(clientIp(req("GET", "/", { "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": "203.0.113.9" }))).toBe("198.51.100.7");
    expect(clientIp(req("GET", "/", { "x-forwarded-for": "1.2.3.4, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(req("GET", "/", { "cf-connecting-ip": "203.0.113.9" }))).toBe("");
    expect(isCloudflareAddress("8.8.8.8")).toBe(false);
  });
});
