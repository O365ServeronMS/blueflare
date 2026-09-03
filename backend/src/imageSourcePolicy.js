import { config } from './config.js';

function allowedImageHost(hostname) {
  return config.imageAllowedHosts.some((allowed) => (
    hostname === allowed || hostname.endsWith('.' + allowed)
  ));
}

export function normalizeAllowedImageSourceUrl(sourceUrl) {
  const value = sourceUrl ? String(sourceUrl).trim() : '';
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !allowedImageHost(parsed.hostname)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourceHost(sourceUrl) {
  try {
    return new URL(String(sourceUrl)).hostname || 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Provider artwork is optional metadata. Drop only invalid artwork so a new
 * provider CDN cannot prevent the canonical movie/source update from landing.
 */
export function sanitizeMovieImageSources(movie) {
  const rejected = [];
  const sanitized = { ...movie };
  for (const field of ['thumbSourceUrl', 'posterSourceUrl']) {
    const original = movie?.[field];
    const normalized = normalizeAllowedImageSourceUrl(original);
    sanitized[field] = normalized;
    if (original && !normalized) rejected.push({ field, host: sourceHost(original) });
  }
  return { movie: sanitized, rejected };
}
