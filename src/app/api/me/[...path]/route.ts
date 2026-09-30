import { handleMe } from "@/lib/account-proxy";

type Context = { params: Promise<{ path: string[] }> };

async function run(request: Request, context: Context) {
  const { path } = await context.params;
  return handleMe(request, path);
}

export const GET = run;
export const PUT = run;
export const POST = run;
export const DELETE = run;
