import { comparableTitle, fetchTmdb, parseTmdbCredits, releaseYear } from './tmdb.js';

/**
 * Identify a catalog row on TMDB by *evidence*, not by title alone.
 *
 * A title search finds candidates; a candidate is accepted only when enough of
 * the catalog's own actor list also appears in that candidate's billed cast.
 * The title guess in `searchTmdbIdByTitle` is right about 92% of the time —
 * fine for a rating lookup, not for printing a cast on a movie page. Requiring
 * shared actors measured 98.8% on a backtest (see docs/adr/PLAN-005).
 *
 * Nothing here writes to the database; the result lands in `tmdb_match_*`,
 * never in `tmdb_id`, so it cannot reach the artwork pipeline.
 */

const MOVIE_MEDIA_TYPES = new Set(['single', 'movie', 'phim-le']);
const SEASON_SUFFIX = /\s*\((?:Season|Phần)\s*(\d+)\)\s*$/iu;

/** How deep into a candidate's billing the catalog's actors are looked for. */
export const CAST_WINDOW = 30;
export const MAX_CANDIDATES = 6;
const PER_QUERY_RESULTS = 5;

export const DEFAULT_POLICY = Object.freeze({
  minOverlap: 2,
  minCatalogActors: 2,
  // Movies only: a TV row's year is its season's, not the series'.
  movieYearGate: true,
  // Two candidates with the same overlap cannot be told apart.
  requireUnique: true
});

export function tmdbEndpointFor(mediaType) {
  return MOVIE_MEDIA_TYPES.has(mediaType) ? 'movie' : 'tv';
}

/** 'Foo (Season 2)' → 2; anything else → null. */
export function seasonOf(title) {
  const found = SEASON_SUFFIX.exec(String(title || ''));
  const season = found ? Number(found[1]) : null;
  return Number.isInteger(season) && season > 0 ? season : null;
}

/** Queries worth running, most specific first. The season suffix is the catalog's, not TMDB's. */
export function searchTitles(title) {
  const stripped = String(title || '').replace(SEASON_SUFFIX, '').trim();
  const queries = [stripped, stripped.split(',')[0].trim()];
  const seen = new Set();
  return queries.filter((query) => {
    const key = comparableTitle(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function actorKeys(actors) {
  return new Set((Array.isArray(actors) ? actors : []).map(comparableTitle).filter(Boolean));
}

/** Distinct catalog actors found in the first CAST_WINDOW of a raw /credits body. */
export function castOverlap(keys, creditsBody) {
  const billed = new Set(
    (Array.isArray(creditsBody?.cast) ? creditsBody.cast : [])
      .slice(0, CAST_WINDOW)
      .map((entry) => comparableTitle(entry?.name))
      .filter(Boolean)
  );
  let count = 0;
  for (const key of keys) if (billed.has(key)) count += 1;
  return count;
}

/**
 * Year sanity, checked per media family. Movies must agree within a year (the
 * same tolerance the title guess uses). A TV row carries its season's year, so
 * the series may only have started at or before it.
 */
export function yearCompatible(endpoint, catalogYear, candidateYear) {
  const year = Number(catalogYear) || null;
  if (!year || !candidateYear) return true;
  if (endpoint === 'movie') return Math.abs(year - candidateYear) <= 1;
  return candidateYear <= year + 1;
}

/**
 * Pick the winner among candidates already scored for overlap.
 * `candidates`: [{ id, year, votes, overlap }]. Pure, so the backtest can replay
 * one set of collected evidence under several policies.
 */
export function decideMatch(candidates, context, policy = DEFAULT_POLICY) {
  const { actorCount, endpoint, year } = context;
  if (actorCount < policy.minCatalogActors) {
    return { status: 'unverifiable', pick: null, reason: 'few-actors' };
  }
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { status: 'none', pick: null, reason: 'no-candidates' };

  const eligible = list
    .filter((candidate) => candidate.overlap >= policy.minOverlap)
    .filter((candidate) => endpoint !== 'movie' || !policy.movieYearGate || yearCompatible(endpoint, year, candidate.year))
    .sort((a, b) => b.overlap - a.overlap || (b.votes || 0) - (a.votes || 0));
  if (!eligible.length) return { status: 'none', pick: null, reason: 'no-overlap' };
  if (policy.requireUnique && eligible.length > 1 && eligible[0].overlap === eligible[1].overlap) {
    return { status: 'unverifiable', pick: null, reason: 'tie' };
  }
  return { status: 'verified', pick: eligible[0], reason: null };
}

/**
 * Search TMDB and score every candidate's cast against the catalog's actors.
 * `keepBodies` retains the raw /credits so a verified pick can be stored
 * without fetching it again.
 */
export async function collectCandidates(row, options = {}) {
  const endpoint = tmdbEndpointFor(row.media_type);
  const keys = actorKeys(row.actors);
  const found = new Map();
  for (const query of searchTitles(row.original_title)) {
    const body = await fetchTmdb('/search/' + endpoint + '?query=' + encodeURIComponent(query), options);
    for (const hit of (Array.isArray(body?.results) ? body.results : []).slice(0, PER_QUERY_RESULTS)) {
      if (!found.has(hit.id)) found.set(hit.id, hit);
    }
  }

  const candidates = [];
  const bodies = new Map();
  for (const hit of [...found.values()].slice(0, MAX_CANDIDATES)) {
    const year = releaseYear(hit);
    // Credits are the expensive call; skip a candidate the policy will reject anyway.
    if (options.prefilterYear && endpoint === 'movie' && !yearCompatible(endpoint, row.year, year)) continue;
    let credits;
    try {
      credits = await fetchTmdb('/' + endpoint + '/' + hit.id + '/credits', options);
    } catch (error) {
      if (error.status === 404) continue;
      throw error;
    }
    candidates.push({ id: hit.id, year, votes: hit.vote_count || 0, overlap: castOverlap(keys, credits) });
    if (options.keepBodies) bodies.set(hit.id, credits);
  }
  return { endpoint, actorCount: keys.size, candidates, bodies };
}

/**
 * Full verdict for one catalog row.
 * Returns { status, match, credits, evidence }; `match` and `credits` are set
 * only when status is 'verified'. Network errors propagate so the caller can
 * record 'error' and retry sooner than it would a genuine miss.
 */
export async function findCastVerifiedMatch(row, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) };
  const { endpoint, actorCount, candidates, bodies } = await collectCandidates(row, {
    ...options,
    keepBodies: true,
    prefilterYear: policy.movieYearGate
  });
  const verdict = decideMatch(candidates, { actorCount, endpoint, year: row.year }, policy);
  const evidence = { candidates: candidates.length, actors: actorCount, reason: verdict.reason };
  if (verdict.status !== 'verified') return { status: verdict.status, match: null, credits: null, evidence };

  const season = seasonOf(row.original_title);
  if (endpoint === 'tv' && season) {
    // 'Foo (Season 5)' cannot be a series that only ever had 3 seasons.
    const series = await fetchTmdb('/tv/' + verdict.pick.id, options);
    if (Number(series?.number_of_seasons) < season) {
      return { status: 'none', match: null, credits: null, evidence: { ...evidence, reason: 'season-out-of-range' } };
    }
  }
  return {
    status: 'verified',
    match: { mediaType: endpoint, tmdbId: verdict.pick.id },
    credits: parseTmdbCredits(bodies.get(verdict.pick.id), options),
    evidence: {
      ...evidence,
      overlap: verdict.pick.overlap,
      votes: verdict.pick.votes,
      year: verdict.pick.year
    }
  };
}
