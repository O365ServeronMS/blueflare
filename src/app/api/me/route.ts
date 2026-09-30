import { handleMe } from "@/lib/account-proxy";

export function GET(request: Request) {
  return handleMe(request, []);
}
