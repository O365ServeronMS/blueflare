"use client";

import { useEffect } from "react";
import { absoluteImageUrl, nextImageFallback } from "@/lib/image-fallback";

export function ImageFallbackHandler() {
  useEffect(() => {
    // A missing asset 404s for both the `/i/m/` and `/i/d/` variants, and each is
    // a valid "not the current src" candidate for the other. Remember everything
    // an element has already attempted so the chain always ends at the local
    // placeholder instead of bouncing between the two variants forever.
    const attempted = new WeakMap<HTMLImageElement, Set<string>>();

    function onError(event: Event) {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.matches("img[data-movie-poster]")) return;

      let tried = attempted.get(image);
      if (!tried) {
        tried = new Set<string>();
        attempted.set(image, tried);
      }
      if (image.currentSrc) tried.add(image.currentSrc);
      if (image.src) tried.add(absoluteImageUrl(image.src, window.location.href));

      const next = nextImageFallback(
        [image.dataset.fallbackSrc, image.dataset.originalSrc, image.dataset.placeholderSrc],
        tried,
        window.location.href
      );
      if (!next) return;

      tried.add(next);
      image.src = next;
      image.removeAttribute("srcset");
    }
    document.addEventListener("error", onError, true);
    return () => document.removeEventListener("error", onError, true);
  }, []);

  return null;
}
