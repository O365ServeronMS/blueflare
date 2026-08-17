/**
 * Poster fallback ordering for `img[data-movie-poster]`.
 *
 * A missing asset 404s for BOTH signed variants (`/i/m/` portrait and `/i/d/`
 * landscape), so "pick any candidate that is not the current src" ping-pongs
 * between the two forever. Callers must therefore track every source an element
 * has already attempted and pass it here, so each candidate is tried at most
 * once and the local placeholder always terminates the chain.
 */
export function absoluteImageUrl(src: string, base: string) {
  try {
    return new URL(src, base).href;
  } catch {
    return "";
  }
}

export function nextImageFallback(candidates: (string | undefined)[], attempted: Set<string>, base: string) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const href = absoluteImageUrl(candidate, base);
    if (href && !attempted.has(href)) return href;
  }
  return "";
}
