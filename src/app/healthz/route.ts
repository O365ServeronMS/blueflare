export function GET() {
  return Response.json({ status: "ok", service: "blueflare-frontend" }, { headers: { "Cache-Control": "no-store" } });
}
