"use client";

import { useEffect, useState } from "react";

export type AccountState = "loading" | "guest" | "user";

/**
 * Resolves login state from GET /api/me. Anything other than a 200 with a
 * user (401, 404 while the endpoint is not deployed, network failure, bad
 * JSON) is treated as logged out.
 */
export function useAccount(pathname: string): AccountState {
  const [state, setState] = useState<AccountState>("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return "guest" as const;
        const body = await res.json().catch(() => null);
        return body?.user ? ("user" as const) : ("guest" as const);
      })
      .catch(() => (controller.signal.aborted ? null : ("guest" as const)))
      .then((next) => {
        if (next) setState(next);
      });
    return () => controller.abort();
    // Re-check after login/logout navigations (full page loads in practice).
  }, [pathname]);

  return state;
}
