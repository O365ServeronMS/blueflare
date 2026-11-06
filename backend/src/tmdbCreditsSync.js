import { mapLimit } from './concurrency.js';
import { config } from './config.js';
import { fetchTmdbCredits } from './tmdb.js';
import {
  listTmdbCreditCandidates,
  recordTmdbCredits,
  recordTmdbCreditsFailure,
  recordTmdbVote
} from './repository.js';

/**
 * Fetch TMDB cast/director credits (and TMDB's own vote score, carried by the
 * same request) for the detail-page cast strip and the person pages.
 *
 * Worker-only. Returns the canonical slugs whose cast strip or tmdb score
 * really changed, for the caller's cache invalidation. Dependencies are
 * injectable so the pass can be tested without a database.
 */
export async function refreshTmdbCredits(deps = {}) {
  const settings = deps.config ?? config;
  if (!settings.tmdbEnabled || !settings.tmdbCreditsEnabled || !settings.tmdbApiKey) return [];
  const list = deps.listCandidates ?? listTmdbCreditCandidates;
  const fetchCredits = deps.fetchCredits ?? fetchTmdbCredits;
  const record = deps.record ?? recordTmdbCredits;
  const recordFailure = deps.recordFailure ?? recordTmdbCreditsFailure;
  const recordVote = deps.recordVote ?? recordTmdbVote;

  const candidates = await list(settings.tmdbCreditsLimit);
  if (!candidates.length) return [];

  const changed = new Set();
  const counts = { ok: 0, empty: 0, not_found: 0, error: 0 };
  await mapLimit(candidates, settings.tmdbCreditsConcurrency, async (candidate) => {
    const mediaType = candidate.media_type;
    const tmdbId = Number(candidate.tmdb_id);
    try {
      const credits = await fetchCredits({ mediaType, tmdbId });
      const status = credits.cast.length || credits.directors.length ? 'ok' : 'empty';
      counts[status] += 1;
      for (const slug of (await record(mediaType, tmdbId, { ...credits, status })) || []) changed.add(slug);
      // A vote failure must not turn a stored credits fetch into an error.
      try {
        for (const slug of (await recordVote(mediaType, tmdbId, credits.vote)) || []) changed.add(slug);
      } catch (error) {
        console.warn('[worker] tmdb vote write failed for ' + mediaType + ':' + tmdbId, error.message);
      }
    } catch (error) {
      const status = error.status === 404 ? 'not_found' : 'error';
      counts[status] += 1;
      await recordFailure(mediaType, tmdbId, status, error.message).catch(() => {});
    }
  });

  console.log('[worker] tmdb credits checked=' + candidates.length +
    ' ok=' + counts.ok + ' empty=' + counts.empty +
    ' not_found=' + counts.not_found + ' error=' + counts.error + ' changed=' + changed.size);
  return [...changed];
}
