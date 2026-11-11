// Pure rules for adopting the TMDB / IMDb ids that NguonC and KKPhim publish on their
// records. No I/O: providerIdentitySync.js reads the rows and applies the decision.
//
// A claim is one provider record's normalized ids (movie_provider_sources.metadata,
// written by normalize.js). The rules (decided with the owner, 2026-11):
// - Two providers naming the same id beat whatever the row holds (an AI guess included).
// - Providers naming different ids never write: both ids go to the AI match as candidates.
// - One provider naming an id fills an empty row; when the row already holds another id
//   the AI match re-judges with both ids as candidates.
// - A tv season: a set season beats null, a provider null never clears a stored season,
//   two set seasons that differ are settled by the "(Phần N)" title marker, else queued.
// - A pinned row (tmdb_identity_pinned) is never rewritten here, only reported.
// - A tv/movie type that contradicts the row's display type is never written.
import { nguoncSeason } from './duplicateMerge.js';

const MEDIA_TYPES = new Set(['movie', 'tv']);
const PROVIDERS = new Set(['nguonc', 'kkphim']);

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function imdbOf(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^tt\d{5,}$/.test(text) ? text : null;
}

/** One provider record's claim, read from its stored metadata. */
export function claimFromMetadata(provider, metadata = {}) {
  const meta = metadata || {};
  const tmdbId = positiveInt(meta.tmdb_id);
  const type = String(meta.tmdb_type || '').toLowerCase();
  const mediaType = tmdbId && MEDIA_TYPES.has(type) ? type : null;
  return {
    provider,
    tmdbId: mediaType ? tmdbId : null,
    mediaType,
    season: mediaType === 'tv' ? positiveInt(meta.tmdb_season) : null,
    imdbId: imdbOf(meta.imdb_id)
  };
}

/** The upsert path's claim for an incoming record (normalize.js output). */
export function claimFromIncoming(incoming) {
  return claimFromMetadata(incoming.provider, {
    tmdb_id: incoming.tmdbId,
    tmdb_type: incoming.tmdbMediaType,
    tmdb_season: incoming.tmdbSeasonNumber,
    imdb_id: incoming.imdbId
  });
}

/**
 * A provider type that plainly contradicts the row: a tv id on a single film, or a movie id on
 * a series. Animation (hoathinh) and anything else unknown is never flagged: an animated film
 * is stored as media_type tv but is a TMDB movie.
 */
export function typeConflict(row, mediaType) {
  const display = String(row?.display_type || '').toLowerCase();
  if (mediaType === 'tv' && display === 'single') return true;
  if (mediaType === 'movie' && (display === 'series' || display === 'tvshows')) return true;
  return false;
}

function rowIdentity(row) {
  const tmdbId = positiveInt(row?.tmdb_id);
  if (!tmdbId) return null;
  return {
    id: tmdbId,
    mediaType: MEDIA_TYPES.has(row.tmdb_media_type) ? row.tmdb_media_type : null,
    season: positiveInt(row.tmdb_season_number)
  };
}

function key(id, mediaType) {
  return id + ':' + mediaType;
}

/** Stable fingerprint of what the providers claim; a review is re-queued only when it changes. */
export function claimsKey(claims) {
  return claims
    .filter((claim) => claim.tmdbId || claim.imdbId)
    .map((claim) => [claim.provider, claim.tmdbId || '', claim.mediaType || '', claim.season || '', claim.imdbId || ''].join(':'))
    .sort()
    .join('|');
}

function imdbDecision(row, claims) {
  const ids = [...new Set(claims.map((claim) => claim.imdbId).filter(Boolean))];
  const have = imdbOf(row?.imdb_id);
  if (!ids.length) return null;
  if (have) return ids.includes(have) ? null : { action: 'conflict', imdbId: ids[0], have };
  return ids.length === 1 ? { action: 'fill', imdbId: ids[0] } : { action: 'conflict', imdbId: ids[0], have: null, ids };
}

/**
 * Decides what the provider ids mean for one canonical row.
 * @param {{row: object, claims: object[]}} input claims: one per available provider record.
 * @returns {{action: string, reason?: string, tier?: string, identity?: object, candidates?: object[], imdb: object|null}}
 *   action: none | noop | assign | resolve-season | find | queue | blocked.
 *   resolve-season: a tv id without a known season; `tier` says how it is written once resolved.
 *   assign.tier: fill (empty row or empty season) | season (season-only rewrite) | overwrite (other id).
 *   queue.reason: providers-disagree | single-vs-existing | type-mismatch (AI candidates in `candidates`)
 *                 | season-disagree | season-vs-title | season-single-dissent (catalog audit).
 *   imdb: null | {action:'fill', imdbId} | {action:'conflict', imdbId, have}.
 */
export function decideProviderIdentity({ row, claims }) {
  const valid = (claims || []).filter((claim) => PROVIDERS.has(claim.provider));
  const imdb = imdbDecision(row, valid);
  const have = rowIdentity(row);
  const withId = valid.filter((claim) => claim.tmdbId);
  const result = (decision) => ({ ...decision, imdb });

  if (!withId.length) {
    // Nobody names a TMDB id: an IMDb id can still find it deterministically.
    const imdbId = imdbOf(row?.imdb_id) || (imdb?.action === 'fill' ? imdb.imdbId : null);
    if (!have && imdbId) return result({ action: 'find', imdbId });
    return result({ action: 'none' });
  }

  const groups = new Map();
  for (const claim of withId) {
    const groupKey = key(claim.tmdbId, claim.mediaType);
    if (!groups.has(groupKey)) groups.set(groupKey, { id: claim.tmdbId, mediaType: claim.mediaType, claims: [] });
    groups.get(groupKey).claims.push(claim);
  }
  const candidates = [...groups.values()].map((group) => ({ id: group.id, type: group.mediaType }));
  const pinned = row?.tmdb_identity_pinned === true;

  if (groups.size > 1) {
    if (have) candidates.push({ id: have.id, type: have.mediaType || candidates[0].type });
    return result({ action: pinned ? 'blocked' : 'queue', reason: pinned ? 'pinned' : 'providers-disagree', candidates: uniqueCandidates(candidates) });
  }

  const [group] = groups.values();
  const providers = new Set(group.claims.map((claim) => claim.provider));
  const agreed = providers.size >= 2;
  const sameId = have && have.id === group.id && (have.mediaType === null || have.mediaType === group.mediaType);

  if (typeConflict(row, group.mediaType)) {
    if (sameId) return result({ action: 'noop' });
    const typed = have ? uniqueCandidates([...candidates, { id: have.id, type: have.mediaType || group.mediaType }]) : candidates;
    return result({ action: pinned ? 'blocked' : 'queue', reason: pinned ? 'pinned' : 'type-mismatch', candidates: typed });
  }

  // Season of the claimed tv id.
  let season = null;
  let seasonSupport = 0;
  if (group.mediaType === 'tv') {
    const marker = nguoncSeason(row || {});
    const seasons = new Map();
    for (const claim of group.claims) {
      if (claim.season) seasons.set(claim.season, (seasons.get(claim.season) || new Set()).add(claim.provider));
    }
    if (seasons.size > 1) {
      if (marker && seasons.has(marker)) {
        season = marker;
        seasonSupport = seasons.get(marker).size + 1;
      } else {
        return result({ action: pinned ? 'blocked' : 'queue', reason: pinned ? 'pinned' : 'season-disagree', candidates, seasons: [...seasons.keys()].sort((a, b) => a - b) });
      }
    } else if (seasons.size === 1) {
      const [[only, who]] = seasons;
      if (marker && marker !== only) {
        if (sameId && have.season === marker) return result({ action: 'noop' });
        return result({ action: pinned ? 'blocked' : 'queue', reason: pinned ? 'pinned' : 'season-vs-title', candidates, seasons: [only], marker });
      }
      season = only;
      seasonSupport = who.size + (marker === only ? 1 : 0);
    } else if (marker) {
      season = marker;
      seasonSupport = 1;
    }
  }

  if (!have) {
    if (pinned) return result({ action: 'blocked', reason: 'pinned', candidates });
    if (group.mediaType === 'tv' && !season) return result({ action: 'resolve-season', tier: 'fill', identity: { id: group.id, mediaType: 'tv', season: null }, reason: 'season-unknown' });
    return result({ action: 'assign', tier: 'fill', identity: { id: group.id, mediaType: group.mediaType, season }, reason: agreed ? 'providers-agree' : 'single-provider' });
  }

  if (sameId) {
    if (group.mediaType !== 'tv') {
      return have.mediaType ? result({ action: 'noop' })
        : result(pinned ? { action: 'blocked', reason: 'pinned' } : { action: 'assign', tier: 'fill', identity: { id: group.id, mediaType: 'movie', season: null }, reason: 'type-fill' });
    }
    // A provider null season never clears a stored one.
    if (!season || season === have.season) {
      if (have.mediaType && have.season) return result({ action: 'noop' });
      if (pinned) return result({ action: 'blocked', reason: 'pinned' });
      if (!season && !have.season) return result({ action: 'resolve-season', tier: 'fill', identity: { id: group.id, mediaType: 'tv', season: null }, reason: 'season-unknown' });
      return result({ action: 'assign', tier: 'fill', identity: { id: group.id, mediaType: 'tv', season: season || have.season }, reason: 'season-fill' });
    }
    if (!have.season) {
      if (pinned) return result({ action: 'blocked', reason: 'pinned' });
      return result({ action: 'assign', tier: 'fill', identity: { id: group.id, mediaType: 'tv', season }, reason: 'season-fill' });
    }
    // A stored season is rewritten only on two agreeing signals (two providers, or one plus the title).
    if (seasonSupport < 2) return result({ action: pinned ? 'blocked' : 'queue', reason: pinned ? 'pinned' : 'season-single-dissent', candidates, seasons: [season], have: have.season });
    if (pinned) return result({ action: 'blocked', reason: 'pinned' });
    return result({ action: 'assign', tier: 'season', identity: { id: group.id, mediaType: 'tv', season }, reason: 'season-agree' });
  }

  // The row holds another id.
  const both = uniqueCandidates([...candidates, { id: have.id, type: have.mediaType || group.mediaType }]);
  if (pinned) return result({ action: 'blocked', reason: 'pinned', candidates: both });
  if (!agreed) return result({ action: 'queue', reason: 'single-vs-existing', candidates: both });
  if (group.mediaType === 'tv' && !season) return result({ action: 'resolve-season', tier: 'overwrite', identity: { id: group.id, mediaType: 'tv', season: null }, reason: 'providers-agree' });
  return result({ action: 'assign', tier: 'overwrite', identity: { id: group.id, mediaType: group.mediaType, season }, reason: 'providers-agree' });
}

function uniqueCandidates(list) {
  const seen = new Set();
  return list.filter((candidate) => {
    const candidateKey = key(candidate.id, candidate.type);
    if (seen.has(candidateKey)) return false;
    seen.add(candidateKey);
    return true;
  });
}

/** Reasons the AI match can settle by choosing among candidate TMDB titles. */
export const AI_REVIEW_REASONS = new Set(['providers-disagree', 'single-vs-existing', 'type-mismatch']);
/**
 * Season questions the AI match cannot settle; the catalog audit and the monthly manual season batch
 * pick them up. 'season-unresolved' comes from providerIdentitySync.js: TMDB /tv could not pick one.
 */
export const SEASON_REVIEW_REASONS = new Set(['season-disagree', 'season-vs-title', 'season-single-dissent', 'season-unresolved']);

/** True when apply mode may make writes of this tier (PROVIDER_TMDB_MODE + PROVIDER_TMDB_TIERS). */
export function tierEnabled(settings, tier) {
  return settings?.providerTmdbMode === 'apply' && (settings.providerTmdbTiers || []).includes(tier);
}

/**
 * The ids the sync upsert may use for one incoming record. KKPhim's are used as before (fill
 * only). NguonC's became available in 2026-11 and stay out of the upsert path until the owner
 * enables the fill tier; normalize.js still stores them in the source metadata either way.
 */
export function upsertIdentityView(incoming, settings) {
  if (incoming.provider !== 'nguonc' || tierEnabled(settings, 'fill')) return incoming;
  if (!incoming.tmdbId && !incoming.imdbId && !incoming.tmdbMediaType && !incoming.tmdbSeasonNumber) return incoming;
  return { ...incoming, tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null, imdbId: null };
}
