"use client";

import { useEffect } from "react";

export function ImageFallbackHandler() {
  useEffect(() => {
    function onError(event: Event) {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.matches("img[data-movie-poster]")) return;
      const candidates = [image.dataset.fallbackSrc, image.dataset.originalSrc, image.dataset.placeholderSrc].filter(Boolean) as string[];
      const next = candidates.find((src) => {
        try {
          const href = new URL(src, window.location.href).href;
          return href !== image.currentSrc && href !== image.src;
        } catch {
          return false;
        }
      });
      if (!next) return;
      image.src = next;
      image.removeAttribute("srcset");
    }
    document.addEventListener("error", onError, true);
    return () => document.removeEventListener("error", onError, true);
  }, []);

  return null;
}
