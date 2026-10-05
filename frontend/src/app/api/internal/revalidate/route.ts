import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

const TAG_PATTERN = /^[a-z0-9:_-]{1,128}$/;

function validSecret(value: string | null, expected: string) {
  if (!value || !expected) return false;
  const actual = Buffer.from(value);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export async function POST(request: Request) {
  const expected = String(process.env.FRONTEND_REVALIDATE_SECRET || "");
  if (!validSecret(request.headers.get("x-blueflare-revalidate"), expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const tags = Array.isArray((body as { tags?: unknown })?.tags)
    ? (body as { tags: unknown[] }).tags.filter((tag): tag is string => typeof tag === "string" && TAG_PATTERN.test(tag)).slice(0, 32)
    : [];
  if (!tags.length) return Response.json({ error: "No valid tags" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  // This endpoint is called by the sync worker after canonical data changes.
  // Expire immediately so the next detail request cannot receive an older
  // score snapshot while a background refresh is attempted.
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return Response.json({ ok: true, tags }, { headers: { "Cache-Control": "no-store" } });
}

export function GET() {
  return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
