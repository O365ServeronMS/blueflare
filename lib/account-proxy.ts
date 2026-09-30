/**
 * Same-origin proxy from the browser to the internal account API
 * (/api/auth/*, /api/me/*). The browser never sees the session token: it lives
 * in the HttpOnly `bf_session` cookie and is attached as a Bearer header here.
 */

export const SESSION_COOKIE = "bf_session";
export const BODY_LIMIT_BYTES = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const SLUG_MAX = 200;

function apiBase() {
  return (process.env.INTERNAL_CATALOG_URL || process.env.CATALOG_BASE_URL || "https://img.bluesia.net").replace(/\/$/, "");
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function jsonResponse(status: number, payload?: unknown, extra: Record<string, string> = {}, cookies: string[] = []) {
  const headers = new Headers({ ...NO_STORE, ...extra });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  if (payload === undefined || status === 204) return new Response(null, { status, headers });
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

// ---------------------------------------------------------------- cookies

export function sessionCookie(token: string, expiresAt: string) {
  const expires = new Date(expiresAt);
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (Number.isFinite(expires.getTime())) parts.push(`Expires=${expires.toUTCString()}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie() {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function readSessionToken(request: Request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_\-.~+/=]{16,256}$/.test(value) ? value : "";
  }
  return "";
}

// ---------------------------------------------------------------- origin (CSRF)

/** Site origin as the browser sees it: Caddy sets X-Forwarded-Host/Proto. */
export function siteOrigin(request: Request) {
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host).split(",")[0].trim();
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function originAllowed(request: Request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin === siteOrigin(request);
}

// ---------------------------------------------------------------- client IP

/*
 * Client IP for the API's rate limits. Chain: browser -> Cloudflare -> Caddy
 * -> Next. deploy/bootstrap-vps.sh sets no `trusted_proxies`, so Caddy discards
 * any inbound X-Forwarded-For and writes the direct peer only. Behind
 * Cloudflare that peer is a Cloudflare edge address, useless as a per-client
 * key. CF-Connecting-IP carries the real visitor, but anyone who reaches the
 * origin directly could forge it. So: trust CF-Connecting-IP only when the
 * Caddy-written peer (last X-Forwarded-For hop) is inside Cloudflare's
 * published ranges; otherwise use that peer address itself.
 */
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32"
];

function parseIp(input: string): { bits: bigint; size: 32 | 128 } | null {
  let ip = input.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const octets = ip.split(".").map(Number);
    if (octets.some((n) => n > 255)) return null;
    return { bits: octets.reduce((acc, n) => (acc << 8n) | BigInt(n), 0n), size: 32 };
  }
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { bits: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n), size: 128 };
}

const cloudflareNets = CLOUDFLARE_RANGES.map((cidr) => {
  const [base, prefix] = cidr.split("/");
  return { ip: parseIp(base)!, prefix: Number(prefix) };
});

export function isCloudflareAddress(value: string) {
  const ip = parseIp(value);
  if (!ip) return false;
  return cloudflareNets.some((net) => {
    if (net.ip.size !== ip.size) return false;
    const shift = BigInt(ip.size - net.prefix);
    return ip.bits >> shift === net.ip.bits >> shift;
  });
}

export function clientIp(request: Request) {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const peer = forwarded[forwarded.length - 1] || "";
  const connecting = (request.headers.get("cf-connecting-ip") || "").trim();
  if (peer && connecting && isCloudflareAddress(peer) && parseIp(connecting)) return connecting;
  return peer && parseIp(peer) ? peer : "";
}

// ---------------------------------------------------------------- body

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) return null;
  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > BODY_LIMIT_BYTES) return null;
  return new TextDecoder().decode(buffer);
}

// ---------------------------------------------------------------- allow-list

const SEGMENT = /^[^\u0000-\u001f\u007f/\\]+$/;

function safeSlug(value: string | undefined) {
  if (!value || value.length > SLUG_MAX || value === "." || value === ".." || !SEGMENT.test(value)) return "";
  return value;
}

/** Map /api/me/<segments> onto an allowed API path, or null when not allowed. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveAdminPath(rest: string[]): { path: string; methods: string[] } | null {
  const [section, id, action, ...extra] = rest;
  if (section !== "users" || extra.length) return null;
  if (id === undefined) return action === undefined ? { path: "/api/me/admin/users", methods: ["GET"] } : null;
  if (!UUID.test(id)) return null;
  if (action === undefined) return { path: `/api/me/admin/users/${id}`, methods: ["DELETE"] };
  if (action === "sessions") return { path: `/api/me/admin/users/${id}/sessions`, methods: ["DELETE"] };
  return null;
}

export function resolveMePath(segments: string[]): { path: string; methods: string[] } | null {
  if (segments[0] === "admin") return resolveAdminPath(segments.slice(1));
  const [head, slug, ...extra] = segments;
  if (extra.length) return null;
  if (!head) return { path: "/api/me", methods: ["GET"] };
  const encoded = slug === undefined ? "" : safeSlug(slug);
  if (slug !== undefined && !encoded) return null;
  const tail = slug === undefined ? "" : `/${encodeURIComponent(encoded)}`;
  const shapes: Record<string, { bare?: string[]; slug?: string[] }> = {
    favorites: { bare: ["GET"], slug: ["PUT", "DELETE"] },
    history: { bare: ["GET"], slug: ["PUT"] },
    import: { bare: ["POST"] }
  };
  const shape = Object.prototype.hasOwnProperty.call(shapes, head) ? shapes[head] : undefined;
  const methods = shape && (slug === undefined ? shape.bare : shape.slug);
  if (!methods) return null;
  return { path: `/api/me/${head}${tail}`, methods };
}

// ---------------------------------------------------------------- upstream

async function callApi(request: Request, path: string, method: string, opts: { token?: string; body?: string | null }) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body != null) headers["Content-Type"] = "application/json";
  const ip = clientIp(request);
  if (ip) headers["X-Forwarded-For"] = ip;
  // Headers are built from scratch: nothing the client sent (authorization,
  // forwarded, x-forwarded-for, cookie...) is passed through.
  return fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: opts.body ?? undefined,
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
}

function passthroughHeaders(upstream: Response) {
  const extra: Record<string, string> = {};
  const retry = upstream.headers.get("retry-after");
  if (retry) extra["Retry-After"] = retry;
  const allow = upstream.headers.get("allow");
  if (allow) extra.Allow = allow;
  return extra;
}

async function relay(upstream: Response, cookies: string[] = []) {
  const extra = passthroughHeaders(upstream);
  if (upstream.status === 204) return jsonResponse(204, undefined, extra, cookies);
  const text = await upstream.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = { error: "upstream_error" }; }
  return jsonResponse(upstream.status, payload, extra, cookies);
}

const BAD_ORIGIN = () => jsonResponse(403, { error: "bad_origin" });
const UNAVAILABLE = (cookies: string[] = []) => jsonResponse(502, { error: "upstream_unavailable" }, {}, cookies);

// ---------------------------------------------------------------- handlers

export async function handleAuthCredentials(request: Request, action: "register" | "login") {
  if (!originAllowed(request)) return BAD_ORIGIN();
  const body = await readBody(request);
  if (body === null) return jsonResponse(413, { error: "payload_too_large" });
  let upstream: Response;
  try {
    upstream = await callApi(request, `/api/auth/${action}`, "POST", { body });
  } catch {
    return UNAVAILABLE();
  }
  if (upstream.status !== 200 && upstream.status !== 201) return relay(upstream);
  let data: any;
  try { data = await upstream.json(); } catch { data = null; }
  if (!data || typeof data.token !== "string" || typeof data.expiresAt !== "string" || !data.user) return UNAVAILABLE();
  return jsonResponse(upstream.status, { user: data.user }, {}, [sessionCookie(data.token, data.expiresAt)]);
}

export async function handleLogout(request: Request) {
  if (!originAllowed(request)) return BAD_ORIGIN();
  const token = readSessionToken(request);
  if (token) {
    try { await callApi(request, "/api/auth/logout", "POST", { token }); } catch { /* cookie is cleared regardless */ }
  }
  return jsonResponse(204, undefined, {}, [clearedCookie()]);
}

// Only the admin user list takes a query string, and only q/page are forwarded.
function adminQuery(request: Request, path: string) {
  if (path !== "/api/me/admin/users") return "";
  const url = new URL(request.url);
  const out = new URLSearchParams();
  const q = url.searchParams.get("q");
  const page = url.searchParams.get("page");
  if (q) out.set("q", q.slice(0, 100));
  if (page && /^\d{1,5}$/.test(page)) out.set("page", page);
  const text = out.toString();
  return text ? `?${text}` : "";
}

export async function handleMe(request: Request, segments: string[]) {
  const method = request.method.toUpperCase();
  const target = resolveMePath(segments);
  if (!target) return jsonResponse(404, { error: "not_found" });
  if (!target.methods.includes(method)) return jsonResponse(405, { error: "method_not_allowed" }, { Allow: target.methods.join(", ") });
  if (!originAllowed(request)) return BAD_ORIGIN();
  const token = readSessionToken(request);
  if (!token) return jsonResponse(401, { error: "unauthorized" });
  let body: string | null = null;
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    body = await readBody(request);
    if (body === null) return jsonResponse(413, { error: "payload_too_large" });
  }
  let upstream: Response;
  try {
    upstream = await callApi(request, target.path + adminQuery(request, target.path), method, { token, body });
  } catch {
    return UNAVAILABLE();
  }
  return relay(upstream, upstream.status === 401 ? [clearedCookie()] : []);
}
