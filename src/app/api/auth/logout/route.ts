import { handleLogout } from "@/lib/account-proxy";

export function POST(request: Request) {
  return handleLogout(request);
}
