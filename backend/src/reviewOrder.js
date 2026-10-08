import { createHash } from 'node:crypto';

/** Score bands are 10 wide, i.e. a review is interchangeable with any within +-5 of the band centre. */
const BAND = 10;

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function seededRank(day, slug, id) {
  return createHash('sha1').update(day + '|' + slug + '|' + id).digest('hex');
}

/**
 * Display order: has_spoiler DESC, score band DESC, then a shuffle that is
 * stable for one UTC day and one movie. Pure and deterministic, so every API
 * replica and every page of a pagination run agree without storing anything.
 * Takes the whole review set; callers slice pages afterwards.
 */
export function orderReviews(reviews, slug, now = Date.now()) {
  const day = dayKey(now);
  return reviews
    .map((review) => ({
      review,
      spoiler: review.hasSpoiler ? 1 : 0,
      band: Math.floor(Number(review.score) / BAND),
      rank: seededRank(day, slug, review.id)
    }))
    .sort((a, b) => b.spoiler - a.spoiler || b.band - a.band || (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((entry) => entry.review);
}

/** Public JSON shape of one review. */
export function reviewCard(row) {
  return {
    id: row.id,
    author: row.author,
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    content: row.content,
    createdAt: row.createdAt,
    url: row.url,
    hasSpoiler: Boolean(row.hasSpoiler),
    // Null unless a translation of the current English text exists.
    contentVi: typeof row.contentVi === 'string' && row.contentVi ? row.contentVi : null
  };
}

const REVIEWS_KEY_SLUG_MAX = 160;
const REVIEWS_INVALIDATE_PAGES = 4;
const REVIEWS_INVALIDATE_LIMITS = [2, 10];

export function reviewsCacheKey(slug, page, limit) {
  const normalized = String(slug || '').trim().toLowerCase().slice(0, REVIEWS_KEY_SLUG_MAX);
  return 'reviews:' + normalized + ':' + page + ':' + limit;
}

export function reviewsInvalidationKeys(slug) {
  const keys = [];
  for (const limit of REVIEWS_INVALIDATE_LIMITS) {
    for (let page = 1; page <= REVIEWS_INVALIDATE_PAGES; page += 1) keys.push(reviewsCacheKey(slug, page, limit));
  }
  return keys;
}
