import { mapLimit } from './concurrency.js';
import { config } from './config.js';
import { fetchTmdbReviews } from './tmdb.js';
import { parseTmdbReviews } from './tmdbReviews.js';
import {
  listTmdbReviewCandidates,
  recordTmdbReviews,
  recordTmdbReviewsFailure
} from './repository.js';

/**
 * Fetch and store TMDB reviews for catalog rows with a verified TMDB identity.
 *
 * Worker-only (never on a request path). Returns the canonical slugs whose
 * visible review set changed, for the caller's existing cache invalidation.
 * A 404 and an empty list both stamp the checked mark with zero reviews; any
 * other failure keeps the stored reviews and only backs the row off.
 * Dependencies are injectable so the pass can be tested without a database.
 */
export async function syncTmdbReviews(deps = {}) {
  const settings = deps.config ?? config;
  if (!settings.tmdbEnabled || !settings.tmdbReviewsEnabled || !settings.tmdbApiKey) return [];
  const list = deps.listCandidates ?? listTmdbReviewCandidates;
  const fetchReviews = deps.fetchReviews ?? fetchTmdbReviews;
  const record = deps.record ?? recordTmdbReviews;
  const recordFailure = deps.recordFailure ?? recordTmdbReviewsFailure;

  const candidates = await list(settings.tmdbReviewsLimit);
  if (!candidates.length) return [];

  const changed = [];
  const counts = { ok: 0, empty: 0, not_found: 0, error: 0 };
  await mapLimit(candidates, settings.tmdbReviewsConcurrency, async (candidate) => {
    const identity = { mediaType: candidate.media_type, tmdbId: Number(candidate.tmdb_id) };
    try {
      let reviews = [];
      let status = 'ok';
      try {
        reviews = parseTmdbReviews(await fetchReviews(identity), {
          maxPerMovie: settings.tmdbReviewsMaxPerMovie,
          now: deps.now
        });
        if (!reviews.length) status = 'empty';
      } catch (error) {
        if (error.status !== 404) throw error;
        status = 'not_found';
      }
      const result = await record(candidate.id, reviews, { refreshMs: settings.tmdbReviewsRefreshMs });
      counts[status] += 1;
      if (result?.changed) changed.push(candidate.canonical_slug);
    } catch (error) {
      counts.error += 1;
      await recordFailure(candidate.id, { retryMs: settings.tmdbReviewsRetryMs }).catch(() => {});
      console.warn('[worker] tmdb reviews failed for ' + candidate.canonical_slug, error.message);
    }
  });

  console.log('[worker] tmdb reviews checked=' + candidates.length +
    ' ok=' + counts.ok + ' empty=' + counts.empty +
    ' not_found=' + counts.not_found + ' error=' + counts.error +
    ' changed=' + changed.length);
  return changed;
}
