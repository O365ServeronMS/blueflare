"use client";

import { useEffect, useState } from "react";
import { fetchContinueWatching, parseContinueItem, type ContinueItem } from "@/lib/continue-watching";

/** Server progress for one title; fetched once, only when the user is logged in. */
export function useContinueItem(slug: string, enabled: boolean): ContinueItem | null {
  const [item, setItem] = useState<ContinueItem | null>(null);
  useEffect(() => {
    if (!enabled) {
      setItem(null);
      return;
    }
    let cancelled = false;
    void fetchContinueWatching().then((body) => {
      if (!cancelled) setItem(parseContinueItem(body, slug));
    });
    return () => {
      cancelled = true;
    };
  }, [slug, enabled]);
  return item;
}
