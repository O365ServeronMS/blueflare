/** Clamp a watch-progress ratio to 0..1; non-finite input counts as 0. */
export function clampProgress(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Width of the poster progress bar as a CSS percentage string (e.g. "42%"). */
export function progressWidth(value?: number | null) {
  return `${Math.round(clampProgress(value) * 1000) / 10}%`;
}
