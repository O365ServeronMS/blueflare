"use client";

import { useEffect, useState } from "react";

export type AccountState = "loading" | "guest" | "user";

/**
 * Resolves login state from GET /api/me. Anything other than a 200 with a
 * user (401, 404 while the endpoint is not deployed, network failure, bad
 * JSON) is treated as logged out.
 */
export function useAccount(pathname: string): AccountState {
  return useAccountDetails(pathname).state;
}

export function useAccountDetails(pathname: string): { state: AccountState; admin: boolean } {
  const [state, setState] = useState<AccountState>("loading");
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return { next: "guest" as const, admin: false };
        const body = await res.json().catch(() => null);
        return body?.user ? { next: "user" as const, admin: body.admin === true } : { next: "guest" as const, admin: false };
      })
      .catch(() => (controller.signal.aborted ? null : { next: "guest" as const, admin: false }))
      .then((result) => {
        if (!result) return;
        setState(result.next);
        setAdmin(result.admin);
      });
    return () => controller.abort();
    // Re-check after login/logout navigations (full page loads in practice).
  }, [pathname]);

  return { state, admin };
}
