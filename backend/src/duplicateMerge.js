/**
 * Pairs NguonC-only movie rows with the KKPhim-only row describing the same work.
 * Pure: callers load the candidate rows and apply the pairs.
 *
 * A pair needs equal normalized original title, year and media type, a compatible
 * season and episode total, one piece of identity evidence (agreeing slugs, the
 * NguonC slug equal to a KKPhim source slug, or two shared cast/director names),
 * and must be one-to-one in both directions; anything else is reported as
 * ambiguous and left alone.
 */

const SEASON_IN_TITLE = /\(\s*ph[aầ]n\s+(\d+)\s*\)/iu;
const SEASON_IN_SLUG = /(?:^|-)phan-(\d+)(?:-\d{4})?$/u;

export function nguoncSeason(row) {
  const fromTitle = SEASON_IN_TITLE.exec(String(row.title || ''));
  if (fromTitle) return Number(fromTitle[1]);
  const fromSlug = SEASON_IN_SLUG.exec(String(row.canonical_slug || ''));
  return fromSlug ? Number(fromSlug[1]) : null;
}

const EPISODE_RATIO_LIMIT = 1.5;

function episodeCount(row) {
  const match = /\d+/.exec(String(row.episode_total ?? ''));
  return match ? Number(match[0]) : 0;
}

// Providers lag each other by a few episodes; a large gap means another season or work.
export function episodeTotalsCompatible(a, b) {
  const x = episodeCount(a);
  const y = episodeCount(b);
  if (!x || !y) return true;
  return Math.max(x, y) / Math.min(x, y) <= EPISODE_RATIO_LIMIT;
}

function groupKey(row) {
  const title = String(row.normalized_original_title || '').trim();
  if (!title || !row.year) return null;
  return title + '|' + row.year + '|' + row.media_type;
}

function slugTokens(slug) {
  return String(slug || '')
    .replace(/-(?:19|20)\d{2}$/u, '')
    .replace(/(?:^|-)phan-\d+(?:-\d+)?$/u, '')
    .replace(/-\d+$/u, '')
    .split('-')
    .filter(Boolean);
}

// Same work means one slug base is a whole-token, in-order run of the other.
export function slugsAgree(a, b) {
  const x = slugTokens(a.canonical_slug);
  const y = slugTokens(b.canonical_slug);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const haystack = ' ' + long.join(' ') + ' ';
  return haystack.includes(' ' + short.join(' ') + ' ');
}

function slugSeason(row) {
  const match = SEASON_IN_SLUG.exec(String(row.canonical_slug || ''));
  return match ? Number(match[1]) : null;
}

function tmdbSeasonCompatible(nguonc, kk) {
  const wanted = nguoncSeason(nguonc);
  const have = kk.tmdb_season_number ?? null;
  if (wanted !== null) return have === wanted;
  return have === null || have === 1;
}

function seasonCompatible(nguonc, kk) {
  const kkSlugSeason = slugSeason(kk);
  const nguoncSlugSeason = slugSeason(nguonc);
  if (kkSlugSeason !== null && nguoncSlugSeason !== null && kkSlugSeason !== nguoncSlugSeason) return false;
  return tmdbSeasonCompatible(nguonc, kk);
}

const stripYear = (slug) => String(slug || '').replace(/-(?:19|20)\d{2}$/u, '');

function personNames(row) {
  const names = new Set();
  for (const list of [row.actors, row.directors]) {
    for (const item of Array.isArray(list) ? list : []) {
      const name = String(typeof item === 'string' ? item : item?.name || '').trim().toLowerCase();
      if (name) names.add(name);
    }
  }
  return names;
}

export function sharedPeople(a, b) {
  const known = personNames(a);
  let shared = 0;
  for (const name of personNames(b)) if (known.has(name)) shared += 1;
  return shared;
}

// The KKPhim row's own source slug is what the provider calls the title, so it
// stays trustworthy even when the row's canonical slug was scrambled by the old
// season collapse.
function sourceSlugMatches(nguonc, kk) {
  const wanted = stripYear(nguonc.canonical_slug);
  return (kk.source_slugs || []).some((slug) => stripYear(slug) === wanted);
}

function evidence(nguonc, kk) {
  if (!tmdbSeasonCompatible(nguonc, kk) || !episodeTotalsCompatible(nguonc, kk)) return null;
  if (seasonCompatible(nguonc, kk) && slugsAgree(nguonc, kk)) return 'slug';
  if (sourceSlugMatches(nguonc, kk)) return 'source';
  if (sharedPeople(nguonc, kk) >= 2) return 'cast';
  return null;
}

// A canonical slug whose season suffix contradicts the row's own season is stale.
function renameTarget(nguonc, kk, how) {
  if (how === 'slug') return null;
  const stale = slugSeason(kk);
  if (stale === null || stale === (kk.tmdb_season_number ?? null)) return null;
  return slugSeason(nguonc) === (kk.tmdb_season_number ?? null) ? nguonc.canonical_slug : null;
}

export function planDuplicateMerges(nguoncRows, kkRows) {
  const kkByKey = new Map();
  for (const row of kkRows) {
    if (row.tmdb_identity_status === 'mismatch') continue;
    const key = groupKey(row);
    if (!key) continue;
    if (!kkByKey.has(key)) kkByKey.set(key, []);
    kkByKey.get(key).push(row);
  }
  const candidates = new Map();
  const claimed = new Map();
  for (const row of nguoncRows) {
    const key = groupKey(row);
    const found = key ? (kkByKey.get(key) || []).filter((kk) => evidence(row, kk) !== null) : [];
    if (!found.length) continue;
    candidates.set(row.id, found);
    for (const kk of found) claimed.set(kk.id, (claimed.get(kk.id) || 0) + 1);
  }
  const pairs = [];
  const ambiguous = [];
  for (const row of nguoncRows) {
    const found = candidates.get(row.id);
    if (!found) continue;
    if (found.length === 1 && claimed.get(found[0].id) === 1) {
      const how = evidence(row, found[0]);
      pairs.push({ keep: found[0], drop: row, evidence: how, renameTo: renameTarget(row, found[0], how) });
    }
    else ambiguous.push({ drop: row, candidates: found });
  }
  return { pairs, ambiguous };
}

/**
 * Conditions worth a human look after a reconcile pass. `stalledCycles` counts
 * consecutive passes that left pairs behind without merging any.
 */
export function mergeAlerts({ remaining, skipped, ambiguous, stalledCycles, pendingThreshold, stallLimit = 3 }) {
  const alerts = [];
  if (skipped > 0) alerts.push('skipped=' + skipped + ' merges failed or went stale');
  if (ambiguous > 0) alerts.push('ambiguous=' + ambiguous + ' pairs need a manual look');
  if (remaining > pendingThreshold) alerts.push('remaining=' + remaining + ' exceeds MERGE_ALERT_PENDING=' + pendingThreshold);
  if (stalledCycles >= stallLimit) alerts.push('no merge progress for ' + stalledCycles + ' cycles with remaining=' + remaining);
  return alerts;
}
