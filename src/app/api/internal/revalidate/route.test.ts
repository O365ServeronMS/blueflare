import { describe, test, expect, vi, beforeEach } from "vitest";

const mockRevalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidateTag: mockRevalidateTag }));

const SECRET = "test-revalidate-secret-123";

beforeEach(() => {
  vi.stubEnv("FRONTEND_REVALIDATE_SECRET", SECRET);
  mockRevalidateTag.mockClear();
});

async function importRoute() {
  vi.resetModules();
  return await import("./route");
}

function postRequest(body: unknown, secret?: string) {
  return new Request("http://localhost/api/internal/revalidate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== undefined ? { "x-blueflare-revalidate": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/revalidate", () => {
  test("returns 401 when secret is missing", async () => {
    const { POST } = await importRoute();
    const res = await POST(new Request("http://localhost/api/internal/revalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["home"] }),
    }));
    expect(res.status).toBe(401);
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  test("returns 401 when secret is wrong", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: ["home"] }, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  test("returns 401 when secret has wrong length (timing-safe guard)", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: ["home"] }, "short"));
    expect(res.status).toBe(401);
  });

  test("returns 200 and revalidates valid tags", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: ["home", "movie:test-slug"] }, SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tags).toEqual(["home", "movie:test-slug"]);
    expect(mockRevalidateTag).toHaveBeenCalledTimes(2);
    expect(mockRevalidateTag).toHaveBeenCalledWith("home", { expire: 0 });
    expect(mockRevalidateTag).toHaveBeenCalledWith("movie:test-slug", { expire: 0 });
  });

  test("returns 400 for invalid JSON", async () => {
    const { POST } = await importRoute();
    const res = await POST(new Request("http://localhost/api/internal/revalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-blueflare-revalidate": SECRET,
      },
      body: "not json",
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  test("returns 400 when no valid tags", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: [] }, SECRET));
    expect(res.status).toBe(400);
  });

  test("rejects tags with special characters", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: ["<script>alert(1)</script>"] }, SECRET));
    expect(res.status).toBe(400);
  });

  test("accepts valid tag patterns", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: ["movie:test-slug_v2"] }, SECRET));
    expect(res.status).toBe(200);
  });

  test("caps tags at 32 entries", async () => {
    const { POST } = await importRoute();
    const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
    const res = await POST(postRequest({ tags }, SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags.length).toBe(32);
    expect(mockRevalidateTag).toHaveBeenCalledTimes(32);
  });

  test("filters out non-string and invalid tags", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: [123, null, "valid-tag", "UPPERCASE"] }, SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toEqual(["valid-tag"]);
  });

  test("all responses include no-store cache header", async () => {
    const { POST } = await importRoute();
    const res = await POST(postRequest({ tags: ["home"] }, SECRET));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/internal/revalidate", () => {
  test("returns 405 with Allow header", async () => {
    const { GET } = await importRoute();
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
