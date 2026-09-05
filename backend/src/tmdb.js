import { config } from './config.js';

function validMovieId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function fetchTrendingMovieIds(options = {}) {
  const apiKey = String(options.apiKey ?? config.tmdbApiKey).trim();
  const baseUrl = String(options.baseUrl ?? config.tmdbBaseUrl).replace(/\/$/, '');
  const language = String(options.language ?? config.tmdbTrendingLanguage).trim();
  const pages = Math.max(1, Math.floor(options.pages ?? config.heroTrendingCandidatePages));
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? config.tmdbRequestTimeoutMs));
  const fetchImpl = options.fetchImpl || fetch;

  if (!apiKey) throw new Error('TMDB API key is not configured');
  if (!baseUrl.startsWith('https://')) throw new Error('TMDB base URL must use HTTPS');

  const ids = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page += 1) {
    const url = new URL(baseUrl + '/trending/movie/week');
    url.searchParams.set('api_key', apiKey);
    if (language) url.searchParams.set('language', language);
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const error = new Error('TMDB returned HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    if (!Array.isArray(body?.results)) throw new Error('TMDB trending response has no results array');
    for (const result of body.results) {
      const id = validMovieId(result?.id);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function validMediaType(value) {
  return value === 'movie' || value === 'tv' ? value : null;
}

function validSeasonNumber(value) {
  const season = Number(value);
  return Number.isInteger(season) && season >= 0 ? season : null;
}

function imageSource(path, size, imageBaseUrl) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const baseUrl = String(imageBaseUrl || config.tmdbImageBaseUrl).replace(/\/$/, '');
  if (!baseUrl.startsWith('https://')) throw new Error('TMDB image base URL must use HTTPS');
  return baseUrl + '/' + size + path;
}

async function fetchTmdb(path, options = {}) {
  const apiKey = String(options.apiKey ?? config.tmdbApiKey).trim();
  const baseUrl = String(options.baseUrl ?? config.tmdbBaseUrl).replace(/\/$/, '');
  const language = String(options.language ?? config.tmdbTrendingLanguage).trim();
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? config.tmdbRequestTimeoutMs));
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) throw new Error('TMDB API key is not configured');
  if (!baseUrl.startsWith('https://')) throw new Error('TMDB base URL must use HTTPS');
  const url = new URL(baseUrl + path);
  url.searchParams.set('api_key', apiKey);
  if (language) url.searchParams.set('language', language);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const error = new Error('TMDB returned HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const MOVIE_MEDIA_TYPES = new Set(['single', 'movie', 'phim-le']);

function comparableTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function releaseYear(result) {
  const year = Number(String(result?.release_date || result?.first_air_date || '').slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : null;
}

/**
 * Pick a search hit confident enough to act on.
 *
 * Identity is guessed from the title, so a plausible-looking single result is
 * not proof: only an unambiguous exact-title match is accepted and anything
 * else returns a reason, so the caller can record why it declined instead of
 * retrying blindly.
 *
 * `requirePoster` defaults on for the artwork caller, where a match without a
 * poster is pointless. The rating-id caller turns it off, since it only needs
 * the id. `year` is a tie-breaker for same-titled rows, never a pre-filter —
 * catalog years are routinely off by one and filtering up front would throw
 * away correct matches.
 */
export function selectUniqueTmdbMatch(results, title, options = {}) {
  const requirePoster = options.requirePoster !== false;
  const year = Number(options.year) || null;
  const wanted = comparableTitle(title);
  if (!wanted) return { match: null, status: 'unmatched' };

  const exact = (Array.isArray(results) ? results : []).filter((result) => (
    comparableTitle(result?.name ?? result?.title) === wanted ||
    comparableTitle(result?.original_name ?? result?.original_title) === wanted
  ));
  let usable = requirePoster
    ? exact.filter((result) => typeof result?.poster_path === 'string' && result.poster_path)
    : exact;

  if (usable.length > 1 && year) {
    const byYear = usable.filter((result) => releaseYear(result) === year);
    if (byYear.length === 1) usable = byYear;
  }

  if (!usable.length) return { match: null, status: 'unmatched' };
  // Two different titles sharing a name and a year cannot be told apart.
  if (usable.length > 1) return { match: null, status: 'ambiguous' };
  return { match: usable[0], status: 'matched' };
}

export async function searchTmdbImagesByTitle(candidate, options = {}) {
  const title = String(candidate?.title || '').trim();
  if (!title) return { match: null, status: 'unmatched' };

  // `media_type` is the catalog's own family, not a TMDB value. `normalize.js`
  // emits 'single' but that is already folded to 'movie' by the time a row is
  // stored, so all three spellings have to count as a movie here.
  const endpoint = MOVIE_MEDIA_TYPES.has(candidate?.mediaType) ? 'movie' : 'tv';
  const body = await fetchTmdb(
    '/search/' + endpoint + '?query=' + encodeURIComponent(title),
    options
  );
  const { match, status } = selectUniqueTmdbMatch(body?.results, title, { year: candidate?.year });
  if (!match) return { match: null, status };

  return {
    status,
    match: {
      tmdbId: validMovieId(match.id),
      thumbSourceUrl: imageSource(match.poster_path, 'w500', options.imageBaseUrl),
      posterSourceUrl: imageSource(match.backdrop_path, 'w1280', options.imageBaseUrl)
    }
  };
}

/**
 * Guess a TMDB id for a row that carries no tmdb_id and no imdb_id, so MDBList
 * has something to look a rating up by.
 *
 * Deliberately does not require a poster: the id is a lookup key, not an
 * artwork source. The result must never be written to `movies.tmdb_id` — a
 * title guess that is wrong costs one row a wrong score, but feeding it into
 * identity resolution would merge two unrelated titles.
 */
export async function searchTmdbIdByTitle(candidate, options = {}) {
  const title = String(candidate?.title || '').trim();
  if (!title) return { tmdbId: null, status: 'unmatched' };

  const endpoint = MOVIE_MEDIA_TYPES.has(candidate?.mediaType) ? 'movie' : 'tv';
  const body = await fetchTmdb(
    '/search/' + endpoint + '?query=' + encodeURIComponent(title),
    options
  );
  const { match, status } = selectUniqueTmdbMatch(body?.results, title, {
    requirePoster: false,
    year: candidate?.year
  });
  return { tmdbId: match ? validMovieId(match.id) : null, status };
}

export async function fetchVerifiedTmdbImages(identity, options = {}) {
  const tmdbId = validMovieId(identity?.tmdbId);
  const mediaType = validMediaType(identity?.mediaType);
  if (!tmdbId || !mediaType) throw new Error('TMDB identity is incomplete');

  if (mediaType === 'movie') {
    const movie = await fetchTmdb('/movie/' + tmdbId, options);
    if (validMovieId(movie?.id) !== tmdbId) {
      const error = new Error('TMDB movie identity mismatch');
      error.code = 'TMDB_ID_MISMATCH';
      throw error;
    }
    return {
      tmdbId,
      mediaType,
      seasonNumber: null,
      thumbSourceUrl: imageSource(movie.poster_path, 'w500', options.imageBaseUrl),
      posterSourceUrl: imageSource(movie.backdrop_path, 'w1280', options.imageBaseUrl)
    };
  }

  const seasonNumber = validSeasonNumber(identity?.seasonNumber);
  if (seasonNumber === null) throw new Error('TMDB TV season identity is incomplete');
  const series = await fetchTmdb('/tv/' + tmdbId, options);
  if (validMovieId(series?.id) !== tmdbId) {
    const error = new Error('TMDB TV identity mismatch');
    error.code = 'TMDB_ID_MISMATCH';
    throw error;
  }
  const season = await fetchTmdb('/tv/' + tmdbId + '/season/' + seasonNumber, options);
  if (validSeasonNumber(season?.season_number) !== seasonNumber) {
    const error = new Error('TMDB season identity mismatch');
    error.code = 'TMDB_SEASON_MISMATCH';
    throw error;
  }
  return {
    tmdbId,
    mediaType,
    seasonNumber,
    thumbSourceUrl: imageSource(season.poster_path, 'w500', options.imageBaseUrl),
    posterSourceUrl: imageSource(series.backdrop_path, 'w1280', options.imageBaseUrl)
  };
}
