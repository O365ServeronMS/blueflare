import { config } from './config.js';

/**
 * OMDb client.
 *
 * Scope is deliberately narrow: look a title up by its IMDb id and read the
 * Tomatometer out of the response. OMDb is only ever queried by id, never by
 * title, because a title guess that lands on the wrong film would attach a
 * visible score to it and there is no signal afterwards that it was wrong.
 *
 * What OMDb does *not* return is worth recording, because it constrains the UI:
 * the audience score (Popcornmeter) is gone. `&tomatoes=true` still accepts the
 * parameter but every `tomato*` field answers "N/A" — OMDb lost its Rotten
 * Tomatoes data licence in 2017 and only the critic percentage survives, inside
 * the generic `Ratings` array. The popcorn badge is therefore sourced from the
 * TMDB user score the catalog already stores, not from here.
 */

function percentValue(value) {
  const match = String(value ?? '').match(/^(\d{1,3})%$/);
  if (!match) return null;
  const score = Number(match[1]);
  return score >= 0 && score <= 100 ? score : null;
}

function outOfHundred(value) {
  const match = String(value ?? '').match(/^(\d{1,3})\/100$/);
  if (!match) return null;
  const score = Number(match[1]);
  return score >= 0 && score <= 100 ? score : null;
}

function ratingOutOfTen(value) {
  const score = Number(value);
  // OMDb writes the string "N/A" for anything it has no value for, which Number
  // turns into NaN; 0 is not a real IMDb rating either.
  return Number.isFinite(score) && score > 0 && score <= 10
    ? Math.round(score * 10) / 10
    : null;
}

function ratingSource(body, source) {
  return (Array.isArray(body?.Ratings) ? body.Ratings : [])
    .find((entry) => entry?.Source === source)?.Value;
}

/**
 * Pull the three scores worth keeping out of an OMDb payload.
 *
 * Every field is independently optional: a row can match OMDb and still carry
 * no Tomatometer at all, which on this catalog is the common case rather than
 * the exception.
 */
export function parseOmdbScores(body) {
  return {
    tomatometer: percentValue(ratingSource(body, 'Rotten Tomatoes')),
    metascore: outOfHundred(ratingSource(body, 'Metacritic')),
    imdbRating: ratingOutOfTen(body?.imdbRating)
  };
}

/** Thrown to abort the whole batch: every further request today answers 401. */
export class OmdbQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OmdbQuotaError';
    this.code = 'OMDB_QUOTA';
  }
}

function validImdbId(value) {
  const id = String(value ?? '').trim();
  return /^tt\d{7,}$/.test(id) ? id : null;
}

/**
 * Look one title up. Resolves to a status rather than throwing for the ordinary
 * "OMDb has never heard of this" case, which is not an error worth retrying
 * soon. Quota exhaustion and a rejected key both throw, because continuing to
 * call would only burn the remainder of the day against a guaranteed 401.
 */
export async function fetchOmdbByImdbId(imdbId, options = {}) {
  const id = validImdbId(imdbId);
  if (!id) return { status: 'unmatched', detail: 'invalid imdb id' };

  const apiKey = String(options.apiKey ?? config.omdbApiKey).trim();
  const baseUrl = String(options.baseUrl ?? config.omdbBaseUrl).replace(/\/$/, '');
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? config.omdbRequestTimeoutMs));
  const fetchImpl = options.fetchImpl || fetch;

  if (!apiKey) throw new Error('OMDb API key is not configured');
  if (!baseUrl.startsWith('https://')) throw new Error('OMDb base URL must use HTTPS');

  const url = new URL(baseUrl + '/');
  url.searchParams.set('i', id);
  url.searchParams.set('apikey', apiKey);

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    // 401 covers both "no requests left today" and "this key is not valid".
    // Both mean stop, but only the first is expected to fix itself.
    const detail = String(body?.Error || 'HTTP ' + response.status);
    if (response.status === 401) throw new OmdbQuotaError(detail);
    const error = new Error('OMDb returned HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }

  if (body?.Response !== 'True') {
    return { status: 'unmatched', detail: String(body?.Error || 'unknown') };
  }
  if (validImdbId(body?.imdbID) !== id) {
    return { status: 'unmatched', detail: 'imdb id mismatch' };
  }

  return { status: 'matched', imdbId: id, ...parseOmdbScores(body) };
}
