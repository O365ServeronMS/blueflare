import { normalizeTitle } from './identity.js';

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * ASCII-only slug body.
 *
 * `slugify()` in identity.js keeps CJK and Cyrillic (it matches on \p{L}), and
 * a person slug reaches the revalidation tag pattern /^[a-z0-9:_-]{1,128}$/ on
 * both sides, where a non-ASCII tag is dropped silently. 2.294 distinct names
 * in the catalog are affected, so this strips instead of transliterating.
 */
export function asciiSlugBody(name) {
  return normalizeTitle(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Permalink for one person.
 *
 * The TMDB id is always appended: it makes the slug deterministic and unique
 * without a retry loop, survives TMDB renaming the person, and keeps a name
 * that strips to nothing (CJK, 'Dang cap nhat') off a shared '/person/movie'
 * — which is where slugify()'s own empty-string fallback would send it.
 */
export function personSlug(name, tmdbPersonId) {
  const id = positiveId(tmdbPersonId);
  if (!id) return '';
  return (asciiSlugBody(name) || 'nguoi') + '-' + id;
}

/**
 * The TMDB identity a catalog row's credits are fetched for.
 *
 * Verified tmdb_id only, unlike `recommendationSource`. A wrong guessed id
 * costs the rail one weak row; here it would print a wrong actor on a movie
 * page, so guessed ids stay out until `movie_credits.confidence` is used.
 */
export function creditIdentity(row) {
  if (!row) return null;
  const tmdbId = positiveId(row.tmdb_id);
  if (!tmdbId) return null;
  if (row.tmdb_media_type !== 'movie' && row.tmdb_media_type !== 'tv') return null;
  return { mediaType: row.tmdb_media_type, tmdbId };
}

/** 'cast' | 'director' | 'all'; anything else reads as 'all'. */
export function normalizeCreditRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return role === 'cast' || role === 'director' ? role : 'all';
}
