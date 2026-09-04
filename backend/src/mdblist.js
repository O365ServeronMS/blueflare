import { createHash } from 'node:crypto';
import { config } from './config.js';

const MEDIA_TYPES = new Set(['movie', 'show']);
const RATING_SOURCES = new Set(['tomatoes', 'audience']);
const ID_PROVIDERS = new Set(['tmdb', 'imdb']);

function providerId(value, provider) {
  const id = String(value ?? '').trim();
  if (provider === 'tmdb') {
    const numeric = Number(id);
    return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : null;
  }
  return /^tt\d{7,}$/.test(id) ? id : null;
}

function percentage(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100
    ? Math.round(score)
    : null;
}

export function mdblistKeyId(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

export class MdblistQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MdblistQuotaError';
    this.code = 'MDBLIST_QUOTA';
  }
}

export class MdblistAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MdblistAuthError';
    this.code = 'MDBLIST_AUTH';
  }
}

/**
 * Validate one MDBList batch response before any score is attached to a movie.
 * Missing ids are ordinary "no rating" results; extra ids are ignored because
 * only requested ids are returned to the caller.
 */
export function parseMdblistRatings(body, expected) {
  const provider = ID_PROVIDERS.has(expected?.provider) ? expected.provider : null;
  const mediaType = MEDIA_TYPES.has(expected?.mediaType) ? expected.mediaType : null;
  const ratingSource = RATING_SOURCES.has(expected?.ratingSource) ? expected.ratingSource : null;
  if (!provider || !mediaType || !ratingSource) throw new Error('MDBList request identity is invalid');
  if (body?.provider_id !== provider || body?.mediatype !== mediaType || body?.provider_rating !== ratingSource) {
    const error = new Error('MDBList response identity mismatch');
    error.code = 'MDBLIST_ID_MISMATCH';
    throw error;
  }
  if (!Array.isArray(body?.ratings)) {
    const error = new Error('MDBList response has no ratings array');
    error.code = 'MDBLIST_SCHEMA';
    throw error;
  }

  const requested = new Set((expected.ids || []).map((id) => providerId(id, provider)).filter(Boolean));
  const ratings = [];
  const seen = new Set();
  for (const entry of body.ratings) {
    const id = providerId(entry?.id, provider);
    const rating = percentage(entry?.rating);
    if (!id || rating === null || !requested.has(id) || seen.has(id)) continue;
    seen.add(id);
    ratings.push({ id, rating });
  }
  return ratings;
}

export async function fetchMdblistRatings(request, options = {}) {
  const provider = ID_PROVIDERS.has(request?.provider) ? request.provider : null;
  const mediaType = MEDIA_TYPES.has(request?.mediaType) ? request.mediaType : null;
  const ratingSource = RATING_SOURCES.has(request?.ratingSource) ? request.ratingSource : null;
  const ids = [...new Set((request?.ids || []).map((id) => providerId(id, provider)).filter(Boolean))];
  const apiKey = String(options.apiKey ?? config.mdblistApiKeys[0] ?? '').trim();
  const baseUrl = String(options.baseUrl ?? config.mdblistBaseUrl).replace(/\/$/, '');
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? config.mdblistRequestTimeoutMs));
  const fetchImpl = options.fetchImpl || fetch;

  if (!provider || !mediaType || !ratingSource || !ids.length) {
    throw new Error('MDBList rating request is incomplete');
  }
  if (!apiKey) throw new Error('MDBList API key is not configured');
  if (!baseUrl.startsWith('https://')) throw new Error('MDBList base URL must use HTTPS');

  const url = new URL(baseUrl + '/rating/' + mediaType + '/' + ratingSource);
  url.searchParams.set('apikey', apiKey);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ provider, ids }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = String(body?.detail || body?.error || 'HTTP ' + response.status);
    if (response.status === 429) throw new MdblistQuotaError(detail);
    if (response.status === 401 || response.status === 403) throw new MdblistAuthError(detail);
    const error = new Error('MDBList returned HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }

  return {
    provider,
    mediaType,
    ratingSource,
    ratings: parseMdblistRatings(body, { provider, mediaType, ratingSource, ids })
  };
}
