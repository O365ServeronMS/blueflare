import { pool } from './db.js';
import { config } from './config.js';
import {
  normalizeAllowedImageSourceUrl,
  sanitizeMovieImageSources
} from './imageSourcePolicy.js';
import {
  isControlledFuzzyMatch,
  normalizeTitle,
  slugify
} from './identity.js';

async function ensureImageAsset(client, sourceUrl) {
  const normalized = normalizeAllowedImageSourceUrl(sourceUrl);
  if (!normalized) return null;
  const result = await client.query(
    'INSERT INTO image_assets (source_url) VALUES ($1) ' +
    'ON CONFLICT (source_url) DO UPDATE SET updated_at=now() RETURNING id',
    [normalized]
  );
  return result.rows[0].id;
}

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function choose(current, incoming, preferIncoming) {
  if (preferIncoming && present(incoming)) return incoming;
  if (present(current)) return current;
  return incoming ?? null;
}

function latest(left, right) {
  const a = left ? Date.parse(left) : 0;
  const b = right ? Date.parse(right) : 0;
  return a >= b ? left : right;
}
function tmdbIdentity(incoming) {
  if (incoming.provider !== 'kkphim') return null;
  const id = Number(incoming.tmdbId);
  const mediaType = incoming.tmdbMediaType;
  const season = Number(incoming.tmdbSeasonNumber);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (mediaType === 'movie') return { id, mediaType, season: null };
  if (mediaType === 'tv' && Number.isInteger(season) && season >= 0) {
    return { id, mediaType, season };
  }
  return null;
}

async function persistTmdbIdentity(client, movieId, incoming) {
  const identity = tmdbIdentity(incoming);
  if (!identity) return null;
  const result = await client.query(
    'UPDATE movies SET tmdb_id=$2, tmdb_media_type=$3, tmdb_season_number=$4, ' +
    "tmdb_identity_status=CASE WHEN tmdb_id IS DISTINCT FROM $2 OR tmdb_media_type IS DISTINCT FROM $3 OR tmdb_season_number IS DISTINCT FROM $4 THEN 'pending' ELSE tmdb_identity_status END, " +
    'tmdb_identity_verified_at=CASE WHEN tmdb_id IS DISTINCT FROM $2 OR tmdb_media_type IS DISTINCT FROM $3 OR tmdb_season_number IS DISTINCT FROM $4 THEN NULL ELSE tmdb_identity_verified_at END, ' +
    'tmdb_thumb_asset_id=CASE WHEN tmdb_id IS DISTINCT FROM $2 OR tmdb_media_type IS DISTINCT FROM $3 OR tmdb_season_number IS DISTINCT FROM $4 THEN NULL ELSE tmdb_thumb_asset_id END, ' +
    'tmdb_poster_asset_id=CASE WHEN tmdb_id IS DISTINCT FROM $2 OR tmdb_media_type IS DISTINCT FROM $3 OR tmdb_season_number IS DISTINCT FROM $4 THEN NULL ELSE tmdb_poster_asset_id END ' +
    'WHERE id=$1 RETURNING *',
    [movieId, identity.id, identity.mediaType, identity.season]
  );
  return result.rows[0];
}


export function mergedMovie(current, incoming) {
  const preferIncoming = incoming.provider === 'nguonc' ||
    current.primary_provider !== 'nguonc';
  return {
    title: choose(current.title, incoming.title, preferIncoming),
    originalTitle: choose(current.original_title, incoming.originalTitle, preferIncoming),
    normalizedTitle: choose(
      current.normalized_title,
      incoming.normalizedTitle,
      preferIncoming
    ),
    normalizedOriginalTitle: choose(
      current.normalized_original_title,
      incoming.normalizedOriginalTitle,
      preferIncoming
    ),
    mediaType: choose(current.media_type, incoming.mediaType, preferIncoming),
    displayType: choose(current.display_type, incoming.displayType, preferIncoming),
    year: choose(current.year, incoming.year, preferIncoming),
    tmdbId: choose(current.tmdb_id, incoming.tmdbId, false),
    imdbId: choose(current.imdb_id, incoming.imdbId, false),
    overview: choose(current.overview, incoming.overview, preferIncoming),
    thumbSourceUrl: choose(
      current.thumb_source_url,
      incoming.thumbSourceUrl,
      preferIncoming
    ),
    posterSourceUrl: choose(
      current.poster_source_url,
      incoming.posterSourceUrl,
      preferIncoming
    ),
    quality: choose(current.quality, incoming.quality, preferIncoming),
    language: choose(current.language, incoming.language, preferIncoming),
    status: choose(current.status, incoming.status, preferIncoming),
    episodeCurrent: choose(
      current.episode_current,
      incoming.episodeCurrent,
      preferIncoming
    ),
    episodeTotal: choose(
      current.episode_total,
      incoming.episodeTotal,
      preferIncoming
    ),
    duration: choose(current.duration, incoming.duration, preferIncoming),
    actors: choose(current.actors, incoming.actors, preferIncoming) || [],
    directors: choose(current.directors, incoming.directors, preferIncoming) || [],
    genres: choose(current.genres, incoming.genres, preferIncoming) || [],
    countries: choose(current.countries, incoming.countries, preferIncoming) || [],
    ratings: {
      ...(current.ratings || {}),
      ...(incoming.ratings || {})
    },
    primaryProvider: incoming.provider === 'nguonc'
      ? 'nguonc'
      : current.primary_provider,
    providerUpdatedAt: latest(
      current.provider_updated_at,
      incoming.providerUpdatedAt
    )
  };
}

async function uniqueSlug(client, preferred, year) {
  const base = slugify(preferred);
  const candidates = [base];
  if (year) candidates.push(base + '-' + year);
  for (let index = 2; index < 100; index += 1) {
    candidates.push(base + '-' + index);
  }
  for (const candidate of candidates) {
    const result = await client.query(
      'SELECT 1 FROM movies WHERE canonical_slug = $1',
      [candidate]
    );
    if (!result.rowCount) return candidate;
  }
  return base + '-' + Date.now();
}

async function findStrongIdentity(client, incoming) {
  const tmdb = tmdbIdentity(incoming);
  if (tmdb) {
    const result = await client.query(
      'SELECT * FROM movies WHERE tmdb_id=$1 AND tmdb_media_type=$2 AND tmdb_season_number IS NOT DISTINCT FROM $3 LIMIT 1',
      [tmdb.id, tmdb.mediaType, tmdb.season]
    );
    if (result.rowCount) return result.rows[0];
    return null;
  }
  if (incoming.imdbId) {
    const result = await client.query(
      'SELECT * FROM movies WHERE imdb_id = $1 AND media_type = $2 LIMIT 1',
      [incoming.imdbId, incoming.mediaType]
    );
    if (result.rowCount) return result.rows[0];
  }
  return null;
}

async function findIdentity(client, incoming) {

  if (incoming.imdbId) {
    const result = await client.query(
      'SELECT * FROM movies WHERE imdb_id = $1 AND media_type = $2 LIMIT 1',
      [incoming.imdbId, incoming.mediaType]
    );
    if (result.rowCount) return result.rows[0];
  }

  if (incoming.year && incoming.normalizedOriginalTitle) {
    const result = await client.query(
      'SELECT * FROM movies WHERE normalized_original_title = $1 ' +
      'AND year = $2 AND media_type = $3 AND tmdb_season_number IS NULL LIMIT 1',
      [incoming.normalizedOriginalTitle, incoming.year, incoming.mediaType]
    );
    if (result.rowCount) return result.rows[0];
  }

  if (incoming.year && incoming.normalizedTitle) {
    const result = await client.query(
      'SELECT * FROM movies WHERE normalized_title = $1 ' +
      'AND year = $2 AND media_type = $3 AND tmdb_season_number IS NULL LIMIT 1',
      [incoming.normalizedTitle, incoming.year, incoming.mediaType]
    );
    if (result.rowCount) return result.rows[0];
  }

  if (!incoming.year) return null;
  const candidates = await client.query(
    'SELECT * FROM movies WHERE year = $1 AND media_type = $2 AND tmdb_season_number IS NULL LIMIT 100',
    [incoming.year, incoming.mediaType]
  );
  return candidates.rows.find((candidate) => (
    isControlledFuzzyMatch(candidate, incoming)
  )) || null;
}

async function findBySource(client, incoming) {
  const result = await client.query(
    'SELECT m.* FROM movies m ' +
    'JOIN movie_provider_sources s ON s.movie_id = m.id ' +
    'WHERE s.provider = $1 AND ' +
    '(s.provider_movie_id = $2 OR s.provider_slug = $3) LIMIT 1',
    [incoming.provider, incoming.providerMovieId, incoming.providerSlug]
  );
  return result.rows[0] || null;
}

async function insertMovie(client, incoming) {
  const canonicalSlug = await uniqueSlug(
    client,
    incoming.providerSlug || incoming.originalTitle || incoming.title,
    incoming.year
  );
  const result = await client.query(
    'INSERT INTO movies (' +
    'canonical_slug, title, original_title, normalized_title, ' +
    'normalized_original_title, media_type, display_type, year, tmdb_id, ' +
    'imdb_id, overview, thumb_source_url, poster_source_url, quality, ' +
    'language, status, episode_current, episode_total, duration, actors, ' +
    'directors, genres, countries, ratings, primary_provider, provider_updated_at, ' +
    'catalog_state, ready_at, catalog_sort_at, thumb_asset_id, poster_asset_id' +
    ') VALUES (' +
    '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,' +
    "$19,$20,$21,$22,$23,$24,$25,$26,'ready',now(),$26,$27,$28" +
    ') RETURNING *',
    [
      canonicalSlug,
      incoming.title,
      incoming.originalTitle,
      incoming.normalizedTitle,
      incoming.normalizedOriginalTitle,
      incoming.mediaType,
      incoming.displayType,
      incoming.year,
      incoming.tmdbId,
      incoming.imdbId,
      incoming.overview,
      incoming.thumbSourceUrl,
      incoming.posterSourceUrl,
      incoming.quality,
      incoming.language,
      incoming.status,
      incoming.episodeCurrent,
      incoming.episodeTotal,
      incoming.duration,
      JSON.stringify(incoming.actors),
      JSON.stringify(incoming.directors),
      JSON.stringify(incoming.genres),
      JSON.stringify(incoming.countries),
      JSON.stringify(incoming.ratings),
      incoming.provider,
      incoming.providerUpdatedAt,
      await ensureImageAsset(client, incoming.thumbSourceUrl),
      await ensureImageAsset(client, incoming.posterSourceUrl)
    ]
  );
  return result.rows[0];
}

async function updateMovie(client, current, incoming) {
  const movie = mergedMovie(current, incoming);
  const thumbAssetId = await ensureImageAsset(client, movie.thumbSourceUrl);
  const posterAssetId = await ensureImageAsset(client, movie.posterSourceUrl);
  const result = await client.query(
    'UPDATE movies SET ' +
    'title=$2, original_title=$3, normalized_title=$4, ' +
    'normalized_original_title=$5, media_type=$6, display_type=$7, year=$8, ' +
    'tmdb_id=$9, imdb_id=$10, overview=$11, thumb_source_url=$12, ' +
    'poster_source_url=$13, quality=$14, language=$15, status=$16, ' +
    'episode_current=$17, episode_total=$18, duration=$19, actors=$20, ' +
    'directors=$21, genres=$22, countries=$23, ratings=$24, ' +
    "primary_provider=$25, provider_updated_at=$26, catalog_state='ready', " +
    'ready_at=COALESCE(ready_at, now()), thumb_asset_id=$27, poster_asset_id=$28, ' +
    'catalog_sort_at=COALESCE($26, catalog_sort_at), updated_at=now() ' +
    'WHERE id=$1 RETURNING *',
    [
      current.id,
      movie.title,
      movie.originalTitle,
      movie.normalizedTitle,
      movie.normalizedOriginalTitle,
      movie.mediaType,
      movie.displayType,
      movie.year,
      movie.tmdbId,
      movie.imdbId,
      movie.overview,
      movie.thumbSourceUrl,
      movie.posterSourceUrl,
      movie.quality,
      movie.language,
      movie.status,
      movie.episodeCurrent,
      movie.episodeTotal,
      movie.duration,
      JSON.stringify(movie.actors),
      JSON.stringify(movie.directors),
      JSON.stringify(movie.genres),
      JSON.stringify(movie.countries),
      JSON.stringify(movie.ratings),
      movie.primaryProvider,
      movie.providerUpdatedAt,
      thumbAssetId,
      posterAssetId
    ]
  );
  return result.rows[0];
}

function movieFingerprint(movie) {
  return JSON.stringify([
    movie.title, movie.original_title, movie.normalized_title,
    movie.normalized_original_title, movie.media_type, movie.display_type,
    movie.year, movie.tmdb_id, movie.imdb_id, movie.overview,
    movie.thumb_source_url, movie.poster_source_url, movie.quality,
    movie.language, movie.status, movie.episode_current, movie.episode_total,
    movie.duration, movie.actors, movie.directors, movie.genres, movie.countries,
    movie.ratings, movie.primary_provider, movie.provider_updated_at
  ]);
}

function sourceFingerprint(source) {
  if (!source) return null;
  return JSON.stringify([source.provider_slug, source.priority, source.availability, source.metadata, source.streams, source.provider_updated_at]);
}

export async function upsertCanonical(incoming) {
  if (!incoming.providerMovieId || !incoming.providerSlug) {
    throw new Error('Provider movie identity is incomplete');
  }
  const sanitizedImages = sanitizeMovieImageSources(incoming);
  incoming = sanitizedImages.movie;
  for (const rejected of sanitizedImages.rejected) {
    console.warn(
      '[repository] dropped untrusted image source provider=' + incoming.provider +
      ' slug=' + incoming.providerSlug +
      ' field=' + rejected.field +
      ' host=' + rejected.host
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceMovie = await findBySource(client, incoming);
    const strongIdentityMovie = await findStrongIdentity(client, incoming);
    const identity = tmdbIdentity(incoming);
    const sourceMatchesIdentity = !sourceMovie || !identity || (
      Number(sourceMovie.tmdb_id) === identity.id && sourceMovie.tmdb_media_type === identity.mediaType &&
      Number(sourceMovie.tmdb_season_number) === Number(identity.season)
    );
    let movie = strongIdentityMovie || (sourceMatchesIdentity ? sourceMovie : null);
    if (!movie && (!sourceMovie || sourceMatchesIdentity)) movie = await findIdentity(client, incoming);
    const previousFingerprint = movie ? movieFingerprint(movie) : null;
    const previousSourceResult = await client.query(
      "SELECT provider_slug, priority, availability, metadata, streams, provider_updated_at FROM movie_provider_sources WHERE provider=$1 AND provider_movie_id=$2 LIMIT 1",
      [incoming.provider, incoming.providerMovieId]
    );
    const previousSource = previousSourceResult.rows[0] || null;
    movie = movie
      ? await updateMovie(client, movie, incoming)
      : await insertMovie(client, incoming);
    movie = (await persistTmdbIdentity(client, movie.id, incoming)) || movie;

    await client.query(
      'INSERT INTO movie_provider_sources (' +
      'movie_id, provider, provider_movie_id, provider_slug, priority, ' +
      'availability, metadata, streams, provider_updated_at, last_success_at' +
      ') VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,now()) ' +
      'ON CONFLICT (provider, provider_movie_id) DO UPDATE SET ' +
      'movie_id=EXCLUDED.movie_id, provider_slug=EXCLUDED.provider_slug, ' +
      'priority=EXCLUDED.priority, availability=true, metadata=EXCLUDED.metadata, ' +
      'streams=EXCLUDED.streams, provider_updated_at=EXCLUDED.provider_updated_at, ' +
      'last_success_at=now(), updated_at=now()',
      [
        movie.id,
        incoming.provider,
        incoming.providerMovieId,
        incoming.providerSlug,
        incoming.priority,
        JSON.stringify(incoming.metadata),
        JSON.stringify(incoming.streams),
        incoming.providerUpdatedAt
      ]
    );
    const currentSourceResult = await client.query(
      "SELECT provider_slug, priority, availability, metadata, streams, provider_updated_at FROM movie_provider_sources WHERE provider=$1 AND provider_movie_id=$2 LIMIT 1",
      [incoming.provider, incoming.providerMovieId]
    );
    const changed = !previousFingerprint || previousFingerprint !== movieFingerprint(movie) ||
      sourceFingerprint(previousSource) !== sourceFingerprint(currentSourceResult.rows[0]);
    await client.query('COMMIT');
    return { movie, changed };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();

  }
}
export async function listTmdbImageCandidates(limit = config.tmdbImageSyncLimit) {
  const result = await pool.query(
    "SELECT * FROM movies WHERE tmdb_identity_status IN ('pending', 'retry') AND tmdb_id IS NOT NULL " +
    "AND (tmdb_image_checked_at IS NULL OR tmdb_image_checked_at < now() - ($1::bigint * interval '1 millisecond')) " +
    'ORDER BY tmdb_image_checked_at NULLS FIRST, updated_at ASC LIMIT $2',
    [config.tmdbImageRetryMs, Math.max(1, Math.floor(limit))]
  );
  return result.rows;
}

export async function recordTmdbImages(movieId, images) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const thumbAssetId = await ensureImageAsset(client, images.thumbSourceUrl);
    const posterAssetId = await ensureImageAsset(client, images.posterSourceUrl);
    const result = await client.query(
      "UPDATE movies SET tmdb_thumb_asset_id=$2, tmdb_poster_asset_id=$3, tmdb_identity_status='verified', " +
      'tmdb_identity_verified_at=now(), tmdb_image_checked_at=now(), updated_at=now() WHERE id=$1 RETURNING *',
      [movieId, thumbAssetId, posterAssetId]
    );
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordTmdbImageFailure(movieId, error) {
  const status = error?.code?.includes('MISMATCH') ? 'mismatch' :
    Number(error?.status) === 404 ? 'unavailable' : 'retry';
  const result = await pool.query(
    'UPDATE movies SET tmdb_identity_status=$2, tmdb_image_checked_at=now(), updated_at=now() WHERE id=$1 RETURNING *',
    [movieId, status]
  );
  return result.rows[0] || null;
}


/**
 * Rows a provider never supplied artwork for, ordered least-recently-checked.
 *
 * Restricted to rows with no provider image of their own, so a borrowed poster
 * can never displace real artwork. Rows already carrying a tmdb_id belong to the
 * verified-by-id pipeline and are left to it.
 */
export async function listTmdbImageFallbackCandidates(limit = config.tmdbImageFallbackLimit) {
  const result = await pool.query(
    'SELECT id, canonical_slug, original_title, title, media_type FROM movies ' +
    "WHERE tmdb_image_fallback_status <> 'matched' " +
    'AND thumb_asset_id IS NULL AND poster_asset_id IS NULL ' +
    'AND tmdb_thumb_asset_id IS NULL AND tmdb_id IS NULL ' +
    "AND catalog_state = 'ready' " +
    "AND original_title IS NOT NULL AND original_title <> '' " +
    "AND (tmdb_image_fallback_checked_at IS NULL OR tmdb_image_fallback_checked_at < now() - ($1::bigint * interval '1 millisecond')) " +
    'ORDER BY tmdb_image_fallback_checked_at NULLS FIRST, updated_at ASC LIMIT $2',
    [config.tmdbImageFallbackRetryMs, Math.max(1, Math.floor(limit))]
  );
  return result.rows;
}

/**
 * Rows with no tmdb_id and no imdb_id, which therefore need an id guessed from
 * their title before MDBList can be asked for a rating. A 'matched' row is
 * never revisited; the rest are retried on the configured cadence.
 */
export async function listTmdbLookupCandidates(limit = config.tmdbLookupLimit) {
  const result = await pool.query(
    'SELECT id, canonical_slug, original_title, title, media_type, year FROM movies ' +
    "WHERE catalog_state = 'ready' AND tmdb_id IS NULL AND imdb_id IS NULL " +
    "AND original_title IS NOT NULL AND original_title <> '' " +
    'AND (tmdb_lookup_checked_at IS NULL ' +
    "  OR (tmdb_lookup_status <> 'matched' " +
    "      AND tmdb_lookup_checked_at < now() - ($1::bigint * interval '1 millisecond'))) " +
    'ORDER BY tmdb_lookup_checked_at NULLS FIRST, updated_at ASC LIMIT $2',
    [config.tmdbLookupRetryMs, Math.max(1, Math.floor(limit))]
  );
  return result.rows;
}

/**
 * Record the guess. `updated_at` is left alone on purpose: nothing a visitor
 * can see changed yet, so this must not look like a content change.
 */
export async function recordTmdbLookup(movieId, status, tmdbId = null) {
  const allowed = ['matched', 'unmatched', 'ambiguous', 'error'].includes(status) ? status : 'error';
  await pool.query(
    'UPDATE movies SET tmdb_lookup_status=$2, tmdb_lookup_id=$3, tmdb_lookup_checked_at=now() WHERE id=$1',
    [movieId, allowed, allowed === 'matched' ? tmdbId : null]
  );
}

export async function recordTmdbImageFallback(movieId, match) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const thumbAssetId = await ensureImageAsset(client, match.thumbSourceUrl);
    const posterAssetId = await ensureImageAsset(client, match.posterSourceUrl);
    // tmdb_id stays NULL on purpose: a title guess must never feed identity
    // resolution, or a bad match could merge two unrelated titles.
    const result = await client.query(
      'UPDATE movies SET tmdb_thumb_asset_id=$2, tmdb_poster_asset_id=$3, ' +
      "tmdb_image_fallback_status='matched', tmdb_image_fallback_id=$4, " +
      'tmdb_image_fallback_checked_at=now(), updated_at=now() WHERE id=$1 RETURNING *',
      [movieId, thumbAssetId, posterAssetId, match.tmdbId]
    );
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordTmdbImageFallbackMiss(movieId, status) {
  const allowed = status === 'ambiguous' || status === 'error' ? status : 'unmatched';
  const result = await pool.query(
    'UPDATE movies SET tmdb_image_fallback_status=$2, tmdb_image_fallback_checked_at=now() ' +
    'WHERE id=$1 RETURNING *',
    [movieId, allowed]
  );
  return result.rows[0] || null;
}

function utcDay() {
  return "(now() AT TIME ZONE 'utc')::date";
}

/** Visible catalog rows that are new or due for an MDBList re-check. */
export async function listMdblistRatingCandidates(slugs = [], limit = config.mdblistBatchLimit) {
  const ordered = [...new Set(slugs.filter(Boolean).map(String))];
  if (!ordered.length) return [];
  const result = await pool.query(
    'SELECT id, canonical_slug, media_type, tmdb_id, tmdb_media_type, imdb_id, ' +
    'tmdb_lookup_id, mdblist_status, mdblist_tomatoes, mdblist_audience FROM movies ' +
    "WHERE canonical_slug = ANY($1::text[]) AND catalog_state = 'ready' " +
    'AND (mdblist_checked_at IS NULL ' +
    "  OR (mdblist_status = 'matched' AND mdblist_checked_at < now() - ($2::bigint * interval '1 millisecond')) " +
    "  OR (mdblist_status IN ('unmatched', 'no-id') AND mdblist_checked_at < now() - ($3::bigint * interval '1 millisecond')) " +
    "  OR (mdblist_status IN ('partial', 'error') AND mdblist_checked_at < now() - ($4::bigint * interval '1 millisecond'))) " +
    'ORDER BY array_position($1::text[], canonical_slug) LIMIT $5',
    [
      ordered,
      config.mdblistRefreshMs,
      config.mdblistMissRetryMs,
      config.mdblistErrorRetryMs,
      Math.max(1, Math.floor(limit))
    ]
  );
  return result.rows;
}

/**
 * Catalog walk for the MDBList backfill: ordered by `id` past a cursor, only
 * ready rows that carry a tmdb/imdb id and are new or due for a re-check.
 * Independent of the visible surfaces so it can reach the deep catalog.
 */
export async function listMdblistBackfillCandidates(cursor = '', limit = config.mdblistBackfillBatchLimit) {
  const after = String(cursor || '').trim();
  const result = await pool.query(
    'SELECT id, canonical_slug, media_type, tmdb_id, tmdb_media_type, imdb_id, ' +
    'tmdb_lookup_id, mdblist_status, mdblist_tomatoes, mdblist_audience FROM movies ' +
    "WHERE catalog_state = 'ready' " +
    'AND (tmdb_id IS NOT NULL OR imdb_id IS NOT NULL OR tmdb_lookup_id IS NOT NULL) ' +
    'AND ($1 = \'\' OR id > $1::uuid) ' +
    'AND (mdblist_checked_at IS NULL ' +
    "  OR (mdblist_status = 'matched' AND mdblist_checked_at < now() - ($2::bigint * interval '1 millisecond')) " +
    "  OR (mdblist_status IN ('unmatched', 'no-id') AND mdblist_checked_at < now() - ($3::bigint * interval '1 millisecond')) " +
    "  OR (mdblist_status IN ('partial', 'error') AND mdblist_checked_at < now() - ($4::bigint * interval '1 millisecond'))) " +
    'ORDER BY id LIMIT $5',
    [
      after,
      config.mdblistRefreshMs,
      config.mdblistMissRetryMs,
      config.mdblistErrorRetryMs,
      Math.max(1, Math.floor(limit))
    ]
  );
  return result.rows;
}

/** Read the MDBList backfill checkpoint, creating an empty one on first run. */
export async function getMdblistBackfillCursor() {
  const result = await pool.query(
    "INSERT INTO crawl_checkpoints (provider, lane, next_page, next_cursor) VALUES ('mdblist','backfill',1,NULL) " +
    'ON CONFLICT (provider, lane) DO UPDATE SET provider = EXCLUDED.provider ' +
    'RETURNING next_cursor, completed_at',
    []
  );
  const row = result.rows[0] || {};
  return { cursor: row.next_cursor || '', completed: Boolean(row.completed_at) };
}

/** Advance (or complete, or reset) the MDBList backfill checkpoint. */
export async function saveMdblistBackfillCursor({ cursor, completed = false, reset = false } = {}) {
  if (reset) {
    await pool.query(
      "UPDATE crawl_checkpoints SET next_cursor=NULL, completed_at=NULL, last_error=NULL, updated_at=now() " +
      "WHERE provider='mdblist' AND lane='backfill'"
    );
    return;
  }
  await pool.query(
    'UPDATE crawl_checkpoints SET next_cursor=$1, completed_at=$2, last_success_at=now(), updated_at=now() ' +
    "WHERE provider='mdblist' AND lane='backfill'",
    [cursor || null, completed ? new Date() : null]
  );
}

/**
 * Persist whichever MDBList sources completed. A failed source leaves its old
 * score untouched, while a successful response with no rating clears it.
 */
export async function recordMdblistResult(movieId, result) {
  const allowed = ['matched', 'partial', 'unmatched', 'error'].includes(result?.status)
    ? result.status : 'error';
  const updated = await pool.query(
    'UPDATE movies SET mdblist_status=$2, ' +
    'mdblist_tomatoes=CASE WHEN $3 THEN $4 ELSE mdblist_tomatoes END, ' +
    'mdblist_audience=CASE WHEN $5 THEN $6 ELSE mdblist_audience END, ' +
    'mdblist_checked_at=now(), ' +
    'updated_at=CASE WHEN $7 THEN now() ELSE updated_at END ' +
    'WHERE id=$1 RETURNING canonical_slug',
    [
      movieId,
      allowed,
      Boolean(result?.tomatoesAttempted),
      result?.tomatoes ?? null,
      Boolean(result?.audienceAttempted),
      result?.audience ?? null,
      Boolean(result?.changed)
    ]
  );
  return updated.rows[0] || null;
}

export async function recordMdblistMiss(movieId, status = 'no-id') {
  const allowed = status === 'no-id' ? status : 'error';
  const result = await pool.query(
    'UPDATE movies SET mdblist_status=$2, mdblist_checked_at=now() ' +
    'WHERE id=$1 RETURNING canonical_slug',
    [movieId, allowed]
  );
  return result.rows[0] || null;
}

/** Claim one or more MDBList HTTP requests from this key's UTC-day budget. */
export async function reserveMdblistBudget(keyId, requested) {
  const key = String(keyId || '').trim();
  const want = Math.max(0, Math.floor(requested));
  const ceiling = Math.max(0, config.mdblistDailyBudget - config.mdblistBudgetReserve);
  if (!key || !want || !ceiling) return { granted: 0, used: 0, ceiling };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO mdblist_budget (day, key_id, used) VALUES (' + utcDay() + ', $1, 0) ' +
      'ON CONFLICT (day, key_id) DO NOTHING',
      [key]
    );
    const locked = await client.query(
      'SELECT used FROM mdblist_budget WHERE day = ' + utcDay() + ' AND key_id = $1 FOR UPDATE',
      [key]
    );
    const used = Number(locked.rows[0]?.used ?? 0);
    const granted = Math.max(0, Math.min(want, ceiling - used));
    if (granted > 0) {
      await client.query(
        'UPDATE mdblist_budget SET used=used+$2, updated_at=now() ' +
        'WHERE day = ' + utcDay() + ' AND key_id=$1',
        [key, granted]
      );
    }
    await client.query('COMMIT');
    return { granted, used: used + granted, ceiling };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getMovieInvalidationDimensions(slugs = []) {
  const normalized = [...new Set(slugs.filter(Boolean).map(String))];
  if (!normalized.length) return [];
  const result = await pool.query(
    "SELECT canonical_slug, genres, countries FROM movies WHERE canonical_slug = ANY($1::text[])",
    [normalized]
  );
  return result.rows;
}

export async function recordProviderSuccess(provider, latencyMs, status = 200, parseFailures = 0) {
  const detailError = parseFailures > 0
    ? String(parseFailures) + ' provider detail/parse failures' : null;
  await pool.query(
    'INSERT INTO provider_health (' +
    'provider,last_success_at,last_latency_ms,last_http_status,consecutive_failures,' +
    'parse_failures,last_error) VALUES ($1,now(),$2,$3,0,$4,$5) ' +
    'ON CONFLICT (provider) DO UPDATE SET last_success_at=now(), ' +
    'last_latency_ms=$2,last_http_status=$3,consecutive_failures=0,' +
    'parse_failures=provider_health.parse_failures+$4,' +
    'last_error=$5,updated_at=now()',
    [provider, latencyMs, status, parseFailures, detailError]
  );
}

export async function recordProviderFailure(provider, error) {
  const status = Number(error?.status) || null;
  const schemaDrift = error?.name === 'ProviderSchemaError' ? 1 : 0;
  await pool.query(
    'INSERT INTO provider_health (' +
    'provider,last_failure_at,last_http_status,consecutive_failures,last_error,' +
    'schema_drift_failures) VALUES ($1,now(),$2,1,$3,$4) ' +
    'ON CONFLICT (provider) DO UPDATE SET last_failure_at=now(), ' +
    'last_http_status=$2,consecutive_failures=provider_health.consecutive_failures+1,' +
    'last_error=$3,schema_drift_failures=' +
    'provider_health.schema_drift_failures+$4,updated_at=now()',
    [provider, status, String(error?.message || error).slice(0, 1000), schemaDrift]
  );
}

export async function getCrawlCheckpoint(provider, lane, startPage) {
  const result = await pool.query(
    'INSERT INTO crawl_checkpoints (provider, lane, next_page) VALUES ($1,$2,$3) ' +
    'ON CONFLICT (provider, lane) DO UPDATE SET updated_at=now() ' +
    'RETURNING *',
    [provider, lane, startPage]
  );
  return result.rows[0];
}

export async function saveCrawlCheckpoint(provider, lane, checkpoint) {
  await pool.query(
    'UPDATE crawl_checkpoints SET next_page=$3, last_page_hash=$4, total_pages=$5, ' +
    'completed_at=$6, last_success_at=now(), last_error=NULL, updated_at=now() ' +
    'WHERE provider=$1 AND lane=$2',
    [
      provider,
      lane,
      checkpoint.nextPage,
      checkpoint.pageHash || null,
      checkpoint.totalPages || null,
      checkpoint.completed ? new Date() : null
    ]
  );
}

export async function recordCrawlCheckpointFailure(provider, lane, error) {
  await pool.query(
    'UPDATE crawl_checkpoints SET last_error=$3, updated_at=now() ' +
    'WHERE provider=$1 AND lane=$2',
    [provider, lane, String(error?.message || error).slice(0, 1000)]
  );
}

function addListFilter(filters, values, sql, value) {
  values.push(value);
  filters.push(sql.replace('?', '$' + values.length));
}

export async function listCanonical(options = {}) {
  const requestedPage = Math.max(1, Math.floor(Number(options.page) || 1));
  const limit = Math.min(64, Math.max(1, Number(options.limit) || 24));
  const filters = ["catalog_state = 'ready'"];
  const values = [];

  const typeMap = {
    'phim-le': ['media_type', 'movie'],
    'phim-bo': ['display_type', 'series'],
    'hoat-hinh': ['display_type', 'hoathinh'],
    'tv-shows': ['display_type', 'tvshows']
  };
  const mappedType = typeMap[options.type];
  if (mappedType) {
    addListFilter(filters, values, mappedType[0] + ' = ?', mappedType[1]);
  }
  if (options.genre) {
    addListFilter(
      filters,
      values,
      "genres @> jsonb_build_array(jsonb_build_object('slug', ?))",
      options.genre
    );
  }
  if (options.country) {
    addListFilter(
      filters,
      values,
      "countries @> jsonb_build_array(jsonb_build_object('slug', ?))",
      options.country
    );
  }
  if (options.keyword) {
    const query = '%' + normalizeTitle(options.keyword) + '%';
    addListFilter(
      filters,
      values,
      '(normalized_title LIKE ? OR normalized_original_title LIKE ?)',
      query
    );
    values.push(query);
    filters[filters.length - 1] = filters[filters.length - 1]
      .replace('?', '$' + values.length);
  }

  const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
  const count = await pool.query(
    'SELECT count(*)::integer AS count FROM movies' + where,
    values
  );
  const totalItems = count.rows[0]?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const page = Math.min(requestedPage, totalPages);
  const queryValues = [...values, limit, (page - 1) * limit];
  const select = options.includePlayable
    ? 'SELECT movies.*, EXISTS (' +
      'SELECT 1 FROM movie_provider_sources source ' +
      "WHERE source.movie_id=movies.id AND source.availability=true " +
      "AND jsonb_typeof(source.streams)='array' " +
      'AND jsonb_array_length(source.streams)>0) AS has_playable_source FROM movies'
    : 'SELECT * FROM movies';

  const rows = await pool.query(
    select + where +
    ' ORDER BY catalog_sort_at DESC NULLS LAST, year DESC NULLS LAST, canonical_slug ASC ' +
    'LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2),
    queryValues
  );
  return {
    rows: rows.rows,
    page,
    limit,
    totalItems,
    totalPages
  };
}


function validTrendingIds(tmdbIds) {
  const seen = new Set();
  return (Array.isArray(tmdbIds) ? tmdbIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0 && !seen.has(value) && seen.add(value));
}

function playableSourceExists(alias = 'movies') {
  return 'EXISTS (SELECT 1 FROM movie_provider_sources source ' +
    'WHERE source.movie_id=' + alias + '.id AND source.availability=true ' +
    "AND jsonb_typeof(source.streams)='array' AND jsonb_array_length(source.streams)>0)";
}

export async function resolveTrendingMovieCandidates(tmdbIds, limit = config.heroTrendingLimit) {
  const ids = validTrendingIds(tmdbIds);
  const safeLimit = Math.min(config.heroTrendingLimit, Math.max(1, Math.floor(Number(limit) || 1)));
  if (!ids.length) return [];
  const result = await pool.query(
    'WITH ranked(tmdb_id, position) AS (SELECT * FROM unnest($1::bigint[]) WITH ORDINALITY) ' +
    'SELECT movies.*, ranked.position FROM ranked JOIN movies ' +
    "ON movies.tmdb_id=ranked.tmdb_id AND movies.media_type='movie' " +
    "WHERE movies.catalog_state='ready' AND movies.canonical_slug<>'' " +
    'AND COALESCE(movies.poster_asset_id, movies.thumb_asset_id) IS NOT NULL ' +
    'AND ' + playableSourceExists('movies') +
    ' ORDER BY ranked.position ASC LIMIT $2',
    [ids, safeLimit]
  );
  return result.rows;
}

export async function getHeroTrendingMovies() {
  const result = await pool.query(
    'SELECT movies.* FROM hero_trending_entries entry JOIN movies ON movies.id=entry.movie_id ' +
    "WHERE movies.catalog_state='ready' AND movies.media_type='movie' AND movies.tmdb_id=entry.tmdb_id " +
    "AND movies.canonical_slug<>'' AND COALESCE(movies.poster_asset_id, movies.thumb_asset_id) IS NOT NULL " +
    'AND ' + playableSourceExists('movies') +
    ' ORDER BY entry.position ASC'
  );
  return result.rows;
}

export async function getHeroTrendingRefreshState() {
  const result = await pool.query('SELECT * FROM hero_trending_refresh_state WHERE singleton=true');
  return result.rows[0] || null;
}

export async function replaceHeroTrendingSnapshot(entries, metadata = {}) {
  const expected = config.heroTrendingLimit;
  if (!Array.isArray(entries) || entries.length !== expected) {
    throw new Error('Hero Trending snapshot must contain exactly ' + expected + ' entries');
  }
  const tmdbIds = new Set(entries.map((entry) => Number(entry.tmdb_id)));
  const movieIds = new Set(entries.map((entry) => String(entry.id)));
  if (tmdbIds.size !== expected || movieIds.size !== expected) {
    throw new Error('Hero Trending snapshot contains duplicate identities');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM hero_trending_entries');
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      await client.query(
        'INSERT INTO hero_trending_entries (position, movie_id, tmdb_id, fetched_at) VALUES ($1,$2,$3,now())',
        [index + 1, entry.id, entry.tmdb_id]
      );
    }
    await client.query(
      'INSERT INTO hero_trending_refresh_state (singleton, last_success_at, last_attempt_at, last_error, candidate_count, matched_count) ' +
      'VALUES (true, now(), now(), NULL, $1, $2) ON CONFLICT (singleton) DO UPDATE SET ' +
      'last_success_at=EXCLUDED.last_success_at, last_attempt_at=EXCLUDED.last_attempt_at, ' +
      'last_error=NULL, candidate_count=EXCLUDED.candidate_count, matched_count=EXCLUDED.matched_count',
      [Number(metadata.candidateCount) || 0, entries.length]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordHeroTrendingRefreshFailure(error, metadata = {}) {
  const message = String(error?.message || error || 'Unknown Hero Trending refresh error').slice(0, 500);
  await pool.query(
    'INSERT INTO hero_trending_refresh_state (singleton, last_attempt_at, last_error, candidate_count, matched_count) ' +
    'VALUES (true, now(), $1, $2, $3) ON CONFLICT (singleton) DO UPDATE SET ' +
    'last_attempt_at=EXCLUDED.last_attempt_at, last_error=EXCLUDED.last_error, ' +
    'candidate_count=EXCLUDED.candidate_count, matched_count=EXCLUDED.matched_count',
    [message, Number(metadata.candidateCount) || 0, Number(metadata.matchedCount) || 0]
  );
}

export async function withHeroTrendingRefreshLock(callback) {
  const client = await pool.connect();
  const lockId = 9271100;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    if (!lock.rows[0]?.locked) return false;
    await callback();
    return true;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    client.release();
  }
}

export async function findMovie(slug) {
  const movieResult = await pool.query(
    'SELECT DISTINCT m.*, (m.canonical_slug=$1) AS canonical_slug_match FROM movies m ' +
    'LEFT JOIN movie_provider_sources s ON s.movie_id=m.id ' +
    "WHERE m.catalog_state='ready' AND (m.canonical_slug=$1 OR s.provider_slug=$1) " +
    'ORDER BY canonical_slug_match DESC, m.catalog_sort_at DESC NULLS LAST, m.canonical_slug ASC LIMIT 1',
    [slug]
  );
  const movie = movieResult.rows[0];
  if (!movie) return null;
  const sources = await pool.query(
    'SELECT * FROM movie_provider_sources WHERE movie_id=$1 AND availability=true ' +
    'ORDER BY priority ASC, provider ASC',
    [movie.id]
  );
  return { movie, sources: sources.rows };
}

export async function recommendations(mediaType, tmdbId, limit = 16) {
  const target = await pool.query(
    "SELECT * FROM movies WHERE catalog_state='ready' AND tmdb_id=$1 AND media_type=$2 LIMIT 1",
    [tmdbId, mediaType]
  );
  if (!target.rowCount) return [];
  const movie = target.rows[0];
  const genre = movie.genres?.[0]?.slug;
  const values = [movie.id, mediaType];
  let genreFilter = '';
  if (genre) {
    values.push(genre);
    genreFilter = " AND genres @> jsonb_build_array(jsonb_build_object('slug', $3))";
  }
  values.push(limit);
  const result = await pool.query(
    "SELECT * FROM movies WHERE catalog_state='ready' AND id<>$1 AND media_type=$2" + genreFilter +
    ' ORDER BY catalog_sort_at DESC NULLS LAST LIMIT $' + values.length,
    values
  );
  return result.rows;
}

export async function taxonomy(field) {
  if (!['genres', 'countries'].includes(field)) throw new Error('Invalid taxonomy field');
  const result = await pool.query(
    'SELECT item->>\'slug\' AS slug, max(item->>\'name\') AS name, count(*)::integer AS count ' +
    "FROM movies, jsonb_array_elements(" + field + ") item WHERE catalog_state='ready' " +
    'GROUP BY item->>\'slug\' ORDER BY name'
  );
  return result.rows;
}

export async function providerHealth() {
  const result = await pool.query(
    'SELECT * FROM provider_health ORDER BY provider'
  );
  return result.rows;
}
