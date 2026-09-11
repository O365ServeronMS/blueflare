export const RECOMMENDATION_LIMIT = 16;
export const RECOMMENDATION_MINIMUM = 4;

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The TMDB identity a catalog row's recommendations are fetched for.
 *
 * A verified tmdb_id wins. The two guessed ids come next: they may be wrong,
 * but a wrong guess only costs this row a less relevant rail — it is never
 * written back to tmdb_id, so it cannot merge titles.
 */
export function recommendationSource(row) {
  if (!row) return null;
  const verified = positiveId(row.tmdb_id);
  if (verified && (row.tmdb_media_type === 'movie' || row.tmdb_media_type === 'tv')) {
    return { mediaType: row.tmdb_media_type, tmdbId: verified };
  }
  if (row.media_type !== 'movie' && row.media_type !== 'tv') return null;
  const guessed = positiveId(row.tmdb_lookup_id) || positiveId(row.tmdb_image_fallback_id);
  return guessed ? { mediaType: row.media_type, tmdbId: guessed } : null;
}

/** Recommendations first, then similar, deduplicated, never the source itself. */
export function mergeRecommendationIds(recommended, similar, excludeId) {
  const exclude = positiveId(excludeId);
  const ids = [];
  const seen = new Set();
  for (const value of [...(recommended || []), ...(similar || [])]) {
    const id = positiveId(value);
    if (id && id !== exclude && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * TMDB-ranked rows first, then genre fill, one card per catalog row, capped.
 * Fewer than the minimum reads as an empty rail, not a sparse one.
 */
export function combineRecommendationRows(ranked, fill, options = {}) {
  const limit = options.limit ?? RECOMMENDATION_LIMIT;
  const minimum = options.minimum ?? RECOMMENDATION_MINIMUM;
  const rows = [];
  const seen = new Set();
  for (const row of [...(ranked || []), ...(fill || [])]) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows.length >= minimum ? rows : [];
}
