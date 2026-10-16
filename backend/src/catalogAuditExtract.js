/**
 * Catalog audit, step 1: read the catalog, flag suspicious rows with fixed detector codes and
 * pack them into small self-contained groups (JSON) that the model and the gate both read.
 *
 * Detectors (pure, on a row with its sources and aliases):
 *   multi-season     sources of one row describe different seasons
 *   season-marker    the row's TMDB season contradicts the "(Phần N)" / "Season N" in its own title
 *   slug-season      the canonical slug's "-phan-N" contradicts the row's season
 *   alias-wrong      an alias slug names another season than the row's
 *   tmdb-mismatch    a KKPhim source names another TMDB id/type than the row holds
 *   type-mismatch    a series/single row carries a TMDB id of the other kind
 *   episode-mismatch sources of one row disagree widely on the episode count
 *   year-spread      sources of one row are more than a year apart
 *   orphan           no available source left (the row cannot play)
 *   dup-same-season  (cross-row) a row without TMDB id has the same title, type, season and
 *                    year (+-1) as a row that has one
 * `tv-no-season` (TMDB tv id without a season) is only counted: the season inference pass owns it.
 *
 * Never on a request path; the worker runs it once a week.
 */
import { normalizeTitle, rowSeason, seasonInSlug, seasonInText } from './identity.js';

export const DETECTORS = Object.freeze(['multi-season', 'season-marker', 'slug-season', 'alias-wrong', 'tmdb-mismatch',
  'type-mismatch', 'episode-mismatch', 'year-spread', 'orphan', 'dup-same-season']);

/** Detectors whose fix needs judgement: the group goes to the model. The others have a deterministic fix. */
export const AI_DETECTORS = new Set(['multi-season', 'season-marker', 'tmdb-mismatch', 'type-mismatch',
  'episode-mismatch', 'year-spread', 'dup-same-season']);

const MAX_GROUP_ROWS = 10;
const int = (value) => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isInteger(n) ? n : null;
};
const has = (value) => value !== null && value !== undefined;

/** Episodes a source actually lists (largest server). */
export function streamEpisodes(streams) {
  if (!Array.isArray(streams)) return 0;
  let best = 0;
  for (const server of streams) {
    const items = server?.server_data ?? server?.items ?? [];
    if (Array.isArray(items) && items.length > best) best = items.length;
  }
  return best;
}

/** Episode count of a source: precomputed by loadCatalog, else counted from its streams. */
export const sourceEpisodes = (source) => (Number.isInteger(source.episodes) ? source.episodes : streamEpisodes(source.streams));

/** Season signals of one provider record: KKPhim TMDB season, title, original title, slug. */
export function sourceSignals(source) {
  const meta = source.metadata || {};
  const tmdb = meta.tmdb_type === 'tv' ? int(meta.tmdb_season) : null;
  return {
    tmdb,
    title: seasonInText(meta.title),
    original: seasonInText(meta.original_title),
    slug: seasonInSlug(source.provider_slug)
  };
}

/** `{ season, strength }`: the season the record describes and how many signals agree with it. */
export function sourceSeason(source) {
  const signals = sourceSignals(source);
  const season = signals.tmdb ?? signals.title ?? signals.original ?? signals.slug;
  if (season === null) return { season: null, strength: 0, conflict: false, signals };
  const values = Object.values(signals).filter(has);
  return { season, strength: values.filter((v) => v === season).length, conflict: values.some((v) => v !== season), signals };
}

/** Season markers carried by the row itself (not its TMDB season). */
export function rowMarkers(row) {
  return { title: seasonInText(row.title), original: seasonInText(row.original_title), slug: seasonInSlug(row.canonical_slug) };
}

const isTv = (row) => row.media_type === 'tv';

/** Detector codes for one row (`row.sources`, `row.aliases` attached). */
export function detectRow(row) {
  const found = new Set();
  const sources = row.sources || [];
  const available = sources.filter((s) => s.availability !== false);
  if (!available.length) found.add('orphan');

  const season = rowSeason(row);
  const markers = rowMarkers(row);
  if (isTv(row)) {
    const seasons = new Set(sources.map((s) => sourceSeason(s).season).filter(has));
    if (seasons.size > 1) found.add('multi-season');
    if (has(row.tmdb_season_number)) {
      const stored = Number(row.tmdb_season_number);
      if ((has(markers.title) && markers.title !== stored) || (has(markers.original) && markers.original !== stored)) found.add('season-marker');
    }
    if (has(markers.slug) && has(season) && markers.slug !== season) found.add('slug-season');
    for (const alias of row.aliases || []) {
      const aliasSeason = seasonInSlug(alias.slug);
      if (has(aliasSeason) && has(season) && aliasSeason !== season) found.add('alias-wrong');
    }
  }

  if (has(row.tmdb_id)) {
    for (const source of sources) {
      if (source.provider !== 'kkphim') continue;
      const meta = source.metadata || {};
      const id = int(meta.tmdb_id);
      if (id && id > 0 && ['movie', 'tv'].includes(meta.tmdb_type) &&
        (id !== Number(row.tmdb_id) || meta.tmdb_type !== row.tmdb_media_type)) found.add('tmdb-mismatch');
    }
    const kind = row.display_type === 'series' ? 'tv' : row.display_type === 'single' ? 'movie' : null;
    if (kind && row.tmdb_media_type && row.tmdb_media_type !== kind) found.add('type-mismatch');
  }

  const episodes = available.map(sourceEpisodes).filter((n) => n > 0);
  if (episodes.length > 1) {
    const max = Math.max(...episodes);
    const min = Math.min(...episodes);
    if (max - min >= 3 && max >= 2 * min) found.add('episode-mismatch');
  }
  const years = sources.map((s) => int(s.metadata?.year)).filter((y) => y && y > 1900);
  if (years.length > 1 && Math.max(...years) - Math.min(...years) > 1) found.add('year-spread');
  return [...found];
}

/** Title key without the season marker, for grouping the seasons of one series. */
export function baseTitle(value) {
  return normalizeTitle(value).replace(/(?:^| )(?:season|phan|phần) \d{1,2}(?: |$)/u, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Cross-row duplicates: same normalized title + media type + season (+-1 year), one row with a TMDB id
 * and one without. Returns pairs `[withId, withoutId]`.
 */
export function detectDuplicates(rows) {
  const byTitle = new Map();
  for (const row of rows) {
    if (row.catalog_state && row.catalog_state !== 'ready') continue;
    const key = row.normalized_title + '|' + row.media_type;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(row);
  }
  const pairs = [];
  for (const list of byTitle.values()) {
    if (list.length < 2 || list.length > 6) continue; // generic titles ("Tình Yêu") are not one work
    const withId = list.filter((r) => has(r.tmdb_id));
    const without = list.filter((r) => !has(r.tmdb_id));
    for (const a of without) {
      const matches = withId.filter((b) => {
        if (has(a.year) && has(b.year) && Math.abs(a.year - b.year) > 1) return false;
        return rowSeason(a) === rowSeason(b);
      });
      if (matches.length === 1) pairs.push([matches[0], a]);
    }
  }
  return pairs;
}

/**
 * Pack flagged rows into groups: a flagged row, the other seasons of the same TMDB id, rows titled
 * like one of its sources, and duplicate partners. `index` = { byId, byTmdb, byTitle }.
 */
export function buildGroups(flagged, index, duplicatePairs = []) {
  const parent = new Map();
  const find = (id) => {
    while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
    return id;
  };
  const add = (id) => { if (!parent.has(id)) parent.set(id, id); };
  const union = (a, b) => { add(a); add(b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const detectors = new Map();
  const mark = (id, codes) => {
    const set = detectors.get(id) || new Set();
    for (const code of codes) set.add(code);
    detectors.set(id, set);
  };

  for (const { row, codes } of flagged) {
    add(row.id);
    mark(row.id, codes);
    const related = new Set();
    if (isTv(row) && has(row.tmdb_id) && codes.some((c) => c !== 'orphan')) {
      for (const id of index.byTmdb.get('tv:' + row.tmdb_id) || []) related.add(id);
    }
    if (codes.some((c) => ['multi-season', 'season-marker', 'slug-season', 'alias-wrong'].includes(c))) {
      for (const source of row.sources || []) {
        const key = normalizeTitle(source.metadata?.title || '') + '|' + row.media_type;
        for (const id of index.byTitle.get(key) || []) related.add(id);
      }
      for (const alias of row.aliases || []) {
        // the season an alias names may live on a sibling row titled like it
        const season = seasonInSlug(alias.slug);
        if (!has(season)) continue;
        for (const id of index.byBase.get(baseTitle(row.title) + '|' + row.media_type) || []) related.add(id);
      }
    }
    related.delete(row.id);
    for (const id of [...related].slice(0, MAX_GROUP_ROWS - 1)) union(row.id, id);
  }
  for (const [a, b] of duplicatePairs) { union(a.id, b.id); mark(a.id, ['dup-same-season']); mark(b.id, ['dup-same-season']); }

  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  const out = [];
  for (const ids of groups.values()) {
    const rows = ids.map((id) => index.byId.get(id)).filter(Boolean)
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || String(a.canonical_slug).localeCompare(String(b.canonical_slug)))
      .slice(0, MAX_GROUP_ROWS);
    if (!rows.length) continue;
    const codes = new Set();
    for (const row of rows) for (const code of detectors.get(row.id) || []) codes.add(code);
    out.push({ key: rows.map((r) => r.id).sort()[0], detectors: [...codes].sort(), rows, flagged: Object.fromEntries(rows.map((r) => [r.id, [...(detectors.get(r.id) || [])]])) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Compact JSON of a group for the model: short field names, only what a decision needs. */
export function groupForModel(group, tmdbFacts = new Map()) {
  const rows = group.rows.map((row) => ({
    id: row.id,
    slug: row.canonical_slug,
    title: row.title,
    original: row.original_title || null,
    year: row.year ?? null,
    type: row.media_type + (row.display_type ? '/' + row.display_type : ''),
    tmdb: has(row.tmdb_id) ? { id: Number(row.tmdb_id), type: row.tmdb_media_type, season: row.tmdb_season_number ?? null, source: row.tmdb_id_source || 'provider' } : null,
    season: rowSeason(row),
    flags: group.flagged[row.id] || [],
    aliases: (row.aliases || []).map((a) => a.slug),
    users: { favorites: row.favorites ?? 0, history: row.history ?? 0 },
    sources: (row.sources || []).map((s) => {
      const meta = s.metadata || {};
      const { season, strength } = sourceSeason(s);
      return {
        id: Number(s.id), provider: s.provider, slug: s.provider_slug, title: meta.title || null, original: meta.original_title || null,
        year: int(meta.year), tmdb: int(meta.tmdb_id) ? { id: int(meta.tmdb_id), type: meta.tmdb_type || null, season: int(meta.tmdb_season) } : null,
        season, signals: strength, episodes: sourceEpisodes(s), available: s.availability !== false
      };
    })
  }));
  const ids = [...new Set(group.rows.filter((r) => r.tmdb_media_type === 'tv' && has(r.tmdb_id)).map((r) => Number(r.tmdb_id)))];
  const tmdb = ids.map((id) => tmdbFacts.get(id)).filter(Boolean);
  return { key: group.key, detectors: group.detectors, rows, ...(tmdb.length ? { tmdb } : {}) };
}

/** The bits of a TMDB /tv/{id} answer the model and the gate use. */
export function tvFacts(show) {
  if (!show || !show.id) return null;
  return {
    id: Number(show.id),
    name: show.name || null,
    original: show.original_name || null,
    seasons: (show.seasons || []).filter((s) => Number(s.season_number) > 0).map((s) => ({
      n: Number(s.season_number), year: s.air_date ? Number(String(s.air_date).slice(0, 4)) : null, episodes: Number(s.episode_count) || 0
    }))
  };
}

// ---- SQL -----------------------------------------------------------------------------------

const ROW_COLUMNS = 'm.id, m.canonical_slug, m.title, m.original_title, m.normalized_title, m.normalized_original_title, ' +
  'm.media_type, m.display_type, m.year, m.tmdb_id, m.tmdb_media_type, m.tmdb_season_number, m.tmdb_id_source, m.imdb_id, ' +
  'm.catalog_state, m.episode_total';

function rowsQuery(where) {
  return `SELECT ${ROW_COLUMNS}, ` +
    "COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'provider', s.provider, 'provider_movie_id', s.provider_movie_id, " +
    "'provider_slug', s.provider_slug, 'availability', s.availability, 'not_found_count', s.not_found_count, " +
    "'first_not_found_at', s.first_not_found_at, 'last_success_at', s.last_success_at, " +
    "'metadata', jsonb_build_object('title', s.metadata->'title', 'original_title', s.metadata->'original_title', 'year', s.metadata->'year', " +
    "'tmdb_id', s.metadata->'tmdb_id', 'tmdb_type', s.metadata->'tmdb_type', 'tmdb_season', s.metadata->'tmdb_season', " +
    "'episode_total', s.metadata->'episode_total', 'type', s.metadata->'type'), " +
    "'episodes', (SELECT COALESCE(max(jsonb_array_length(COALESCE(x->'server_data', x->'items', '[]'::jsonb))), 0) " +
    "FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.streams)='array' THEN s.streams ELSE '[]'::jsonb END) x)" +
    ") ORDER BY s.id) FROM movie_provider_sources s WHERE s.movie_id=m.id), '[]'::jsonb) AS sources, " +
    "COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', a.slug) ORDER BY a.slug) FROM movie_slug_aliases a WHERE a.movie_id=m.id), '[]'::jsonb) AS aliases, " +
    '(SELECT count(*)::int FROM user_favorites f WHERE f.movie_id=m.id) AS favorites, ' +
    '(SELECT count(*)::int FROM user_history h WHERE h.movie_id=m.id) AS history ' +
    'FROM movies m WHERE ' + where;
}

/** Keyset scan of every ready row with its sources, aliases and user-row counts, `batch` rows a query. */
export async function loadCatalog(db, { batch = 2000, isStopping = () => false } = {}) {
  const rows = [];
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    if (isStopping()) break;
    const page = (await db.query(rowsQuery("m.catalog_state='ready' AND m.id > $1 ORDER BY m.id LIMIT $2"), [after, batch])).rows;
    rows.push(...page);
    if (page.length < batch) break;
    after = page[page.length - 1].id;
  }
  return rows;
}

/** The same shape for a few rows, any state (the apply step re-reads a group before each action). */
export async function loadRows(db, ids) {
  if (!ids.length) return [];
  return (await db.query(rowsQuery('m.id = ANY($1::uuid[]) ORDER BY m.id'), [ids])).rows;
}

/** Index + detectors over a loaded catalog. Returns `{ groups, counts, family, holderOf }`. */
export function analyseCatalog(rows) {
  const byId = new Map();
  const byTmdb = new Map();
  const byTitle = new Map();
  const byBase = new Map();
  const push = (map, key, id) => { if (!map.has(key)) map.set(key, []); map.get(key).push(id); };
  const counts = { rows: rows.length, 'tv-no-season': 0 };
  for (const code of DETECTORS) counts[code] = 0;
  for (const row of rows) {
    byId.set(row.id, row);
    if (has(row.tmdb_id)) push(byTmdb, row.tmdb_media_type + ':' + row.tmdb_id, row.id);
    push(byTitle, row.normalized_title + '|' + row.media_type, row.id);
    if (isTv(row)) push(byBase, baseTitle(row.title) + '|' + row.media_type, row.id);
    if (row.tmdb_media_type === 'tv' && has(row.tmdb_id) && !has(row.tmdb_season_number)) counts['tv-no-season'] += 1;
  }
  const familyIds = new Map(byBase);
  // a base title shared by many rows is generic, not one series: too wide to group on
  for (const [key, ids] of byBase) if (ids.length > 12) byBase.delete(key);

  const flagged = [];
  for (const row of rows) {
    const codes = detectRow(row);
    for (const code of codes) counts[code] += 1;
    if (codes.length) flagged.push({ row, codes });
  }
  const pairs = detectDuplicates(rows);
  counts['dup-same-season'] = pairs.length;
  const groups = buildGroups(flagged, { byId, byTmdb, byTitle, byBase }, pairs);
  /** Every row of the series a row belongs to (same base title, or same TMDB tv id), catalog-wide. */
  const family = (row) => {
    const ids = new Set([...(familyIds.get(baseTitle(row.title) + '|' + row.media_type) || []),
      ...(has(row.tmdb_id) && row.tmdb_media_type === 'tv' ? byTmdb.get('tv:' + row.tmdb_id) || [] : [])]);
    ids.delete(row.id);
    return [...ids].map((id) => byId.get(id));
  };
  const tuples = new Map();
  for (const row of rows) if (has(row.tmdb_id)) tuples.set(tupleKey(row.tmdb_id, row.tmdb_media_type, row.tmdb_season_number), row.id);
  const holderOf = (id, type, season) => tuples.get(tupleKey(id, type, season)) ?? null;
  return { groups, counts, family, holderOf };
}

const tupleKey = (id, type, season) => type + ':' + Number(id) + ':' + (type === 'tv' ? (season ?? '') : '');

/** True when the group needs the model; false when only deterministic detectors fired. */
export const needsModel = (group) => group.detectors.some((code) => AI_DETECTORS.has(code));
