import { handleAuthCredentials } from "@/lib/account-proxy";

export function POST(request: Request) {
  return handleAuthCredentials(request, "login");
}
