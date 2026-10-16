/**
 * Catalog audit, step 3: the deterministic gate. The model (or a deterministic rule) proposes
 * actions on one group; every action is checked here against the group's data, and an action
 * that passes is simulated on an in-memory copy so the next action of the same group is
 * checked against the state the earlier ones leave behind (dry-run reports what apply would do).
 *
 * Vocabulary (params are ids from the group only):
 *   set_season  {movieId, season}     correct the TMDB season of a tv row
 *   move_source {sourceId}            re-ingest a provider record that sits on the wrong row
 *   merge_rows  {keepId, dropId}      fold a row without TMDB id into its twin that has one
 *   fix_alias   {slug, toMovieId}     re-point an alias naming another season to the row of that season
 *   rename_slug {movieId}             replace a canonical slug naming another season
 *   hide_row    {movieId}             no available source: catalog_state 'unavailable' (never deleted)
 *   clear_tmdb  {movieId}             drop an inferred TMDB id every KKPhim record contradicts
 *   report      {movieId, note}       needs a human (wrong movie/tv type, ...); never applied
 *   none        {}
 * Pure: no I/O.
 */
import { normalizeTitle, rowSeason, seasonInSlug, seasonInText } from './identity.js';
import { baseTitle, sourceSeason } from './catalogAuditExtract.js';

export const ACTIONS = Object.freeze(['set_season', 'move_source', 'merge_rows', 'fix_alias', 'rename_slug', 'hide_row',
  'clear_tmdb', 'report', 'none']);

const has = (value) => value !== null && value !== undefined;
const int = (value) => {
  const n = Number(value);
  return has(value) && value !== '' && Number.isInteger(n) ? n : null;
};
const available = (source) => source.availability !== false;

/**
 * Mutable copy of a group. `holderOf(tmdbId, mediaType, season)` answers for rows outside the
 * group (the catalog-wide tuple index); `facts` maps a TMDB tv id to tvFacts().
 */
export function createState(rows, { facts = new Map(), holderOf = () => null, family = () => [] } = {}) {
  const byId = new Map(rows.map((row) => [row.id, {
    ...row, sources: (row.sources || []).map((s) => ({ ...s })), aliases: (row.aliases || []).map((a) => ({ ...a }))
  }]));
  const tuples = new Map();
  const tupleKey = (id, type, season) => type + ':' + id + ':' + (type === 'tv' ? (season ?? '') : '');
  for (const row of byId.values()) if (has(row.tmdb_id)) tuples.set(tupleKey(Number(row.tmdb_id), row.tmdb_media_type, row.tmdb_season_number), row.id);
  return {
    byId,
    facts,
    /** Other seasons of the row's series: the group's rows plus the catalog-wide family (`family(row)`). */
    seasonsOf(row) {
      const out = new Map();
      for (const other of [...byId.values(), ...family(row).filter((r) => !byId.has(r.id))]) {
        if (other.id !== row.id && other.media_type === row.media_type && sameBase(other, row)) out.set(other.id, other);
      }
      return [...out.values()];
    },
    holder(id, type, season, exceptId) {
      const key = tupleKey(id, type, season);
      if (tuples.has(key)) {
        const found = tuples.get(key);
        return found === exceptId ? null : found;
      }
      const outside = holderOf(id, type, season);
      return outside && outside !== exceptId && !byId.has(outside) ? outside : null;
    },
    setTuple(row, season) {
      tuples.delete(tupleKey(Number(row.tmdb_id), row.tmdb_media_type, row.tmdb_season_number));
      row.tmdb_season_number = season;
      tuples.set(tupleKey(Number(row.tmdb_id), row.tmdb_media_type, season), row.id);
    },
    clearTuple(row) {
      tuples.delete(tupleKey(Number(row.tmdb_id), row.tmdb_media_type, row.tmdb_season_number));
      Object.assign(row, { tmdb_id: null, tmdb_media_type: null, tmdb_season_number: null, tmdb_id_source: null });
    },
    sourceRow(sourceId) {
      for (const row of byId.values()) {
        const source = row.sources.find((s) => Number(s.id) === Number(sourceId));
        if (source) return { row, source };
      }
      return null;
    }
  };
}

const titleKeys = (row) => new Set([row.normalized_title, row.normalized_original_title, normalizeTitle(row.title), normalizeTitle(row.original_title)].filter(Boolean));
const sameBase = (a, b) => baseTitle(a.title) === baseTitle(b.title) ||
  (Boolean(a.original_title) && baseTitle(a.original_title) === baseTitle(b.original_title));

/** Row-level season evidence: the markers in its own title/original/slug and its sources (minus `skip`). */
function seasonEvidence(row, season, skip = new Set()) {
  let support = 0;
  const against = [];
  const markers = { title: seasonInText(row.title), original: seasonInText(row.original_title), slug: seasonInSlug(row.canonical_slug) };
  for (const [name, value] of Object.entries(markers)) {
    if (!has(value)) continue;
    if (value === season) support += 1;
    else against.push(name);
  }
  for (const source of row.sources) {
    if (skip.has(Number(source.id)) || !available(source)) continue;
    const found = sourceSeason(source);
    if (!has(found.season)) continue;
    if (found.season === season) support += 1;
    else if (found.strength >= 2 && !found.conflict) against.push('source:' + source.id);
  }
  return { support, against };
}

const fail = (gate) => ({ ok: false, gate });
const pass = (detail = {}) => ({ ok: true, ...detail });

function gateSetSeason(state, params, pending) {
  const row = state.byId.get(params.movieId);
  const season = int(params.season);
  if (!row) return fail('unknown-row');
  if (row.media_type !== 'tv' || row.tmdb_media_type !== 'tv' || !has(row.tmdb_id)) return fail('not-tv-with-id');
  if (!season || season < 1 || season > 99) return fail('bad-season');
  if (Number(row.tmdb_season_number) === season) return fail('already-set');
  // Markers the rename/alias steps of the same proposal fix do not count against it.
  const evidence = seasonEvidence(row, season, pending.movedSources);
  const against = evidence.against.filter((name) => !(name === 'slug' && pending.renamed.has(row.id)));
  if (against.length) return fail('contradicted:' + against.join(','));
  if (evidence.support < 2) return fail('weak-evidence');
  const facts = state.facts.get(Number(row.tmdb_id));
  if (!facts) return fail('no-tmdb-facts');
  const tmdbSeason = facts.seasons.find((s) => s.n === season);
  if (!tmdbSeason) return fail('season-not-on-tmdb');
  if (has(row.year) && has(tmdbSeason.year) && Math.abs(Number(row.year) - tmdbSeason.year) > 1) return fail('tmdb-year');
  if (state.holder(Number(row.tmdb_id), 'tv', season, row.id)) return fail('season-held');
  return pass({ slugs: [row.canonical_slug], apply: () => state.setTuple(row, season) });
}

function gateMoveSource(state, params) {
  const found = state.sourceRow(params.sourceId);
  if (!found) return fail('unknown-source');
  const { row, source } = found;
  if (!row.sources.some((s) => s !== source && available(s))) return fail('last-source');
  const described = sourceSeason(source);
  const current = rowSeason(row);
  let basis = null;
  if (row.media_type === 'tv' && has(described.season) && !described.conflict &&
    (described.strength >= 2 || has(described.signals.tmdb)) && has(current) && described.season !== current) basis = 'season';
  if (!basis) {
    const meta = source.metadata || {};
    const names = [normalizeTitle(meta.title), normalizeTitle(meta.original_title)].filter(Boolean);
    const keys = titleKeys(row);
    if (names.length && names.every((name) => !keys.has(name) && !keys.has(baseTitle(name)))) basis = 'title';
  }
  if (!basis) return fail('belongs-here');
  const target = [...state.byId.values()].find((other) => other !== row && basis === 'season' &&
    rowSeason(other) === described.season && sameBase(other, row) && other.media_type === row.media_type);
  return pass({
    basis, expect: target?.id ?? null, slugs: [row.canonical_slug, ...(target ? [target.canonical_slug] : [])],
    apply: () => {
      row.sources = row.sources.filter((s) => s !== source);
      if (target) target.sources.push(source);
    }
  });
}

function gateMergeRows(state, params) {
  const keep = state.byId.get(params.keepId);
  const drop = state.byId.get(params.dropId);
  if (!keep || !drop || keep === drop) return fail('unknown-row');
  if (has(keep.tmdb_id) === has(drop.tmdb_id)) return fail('needs-one-tmdb-id');
  const [withId, without] = has(keep.tmdb_id) ? [keep, drop] : [drop, keep];
  if (withId.media_type !== without.media_type) return fail('type-differs');
  if (rowSeason(withId) !== rowSeason(without)) return fail('season-differs');
  if (has(withId.year) && has(without.year) && Math.abs(Number(withId.year) - Number(without.year)) > 1) return fail('year-differs');
  if (withId.imdb_id && without.imdb_id && withId.imdb_id !== without.imdb_id) return fail('imdb-differs');
  const a = titleKeys(withId);
  if (![...titleKeys(without)].some((key) => a.has(key))) return fail('title-differs');
  return pass({
    withId: withId.id, without: without.id, slugs: [withId.canonical_slug, without.canonical_slug],
    apply: () => {
      withId.sources.push(...without.sources);
      withId.aliases.push({ slug: without.canonical_slug }, ...without.aliases);
      state.byId.delete(without.id);
    }
  });
}

function gateFixAlias(state, params) {
  const slug = String(params.slug || '');
  const row = [...state.byId.values()].find((r) => r.aliases.some((a) => a.slug === slug));
  if (!row) return fail('unknown-alias');
  const aliasSeason = seasonInSlug(slug);
  const current = rowSeason(row);
  if (!has(aliasSeason) || !has(current) || aliasSeason === current) return fail('alias-agrees');
  if (row.sources.some((s) => available(s) && sourceSeason(s).season === aliasSeason)) return fail('row-has-that-season');
  const siblings = state.seasonsOf(row).filter((other) => rowSeason(other) === aliasSeason);
  // Only re-pointed, never dropped: a slug that worked keeps working until its season has a row.
  const target = siblings.find((other) => other.id === params.toMovieId);
  if (!target) return fail(siblings.length ? 'target-not-that-season' : 'no-sibling');
  if (siblings.length > 1) return fail('several-siblings');
  return pass({
    slugs: [row.canonical_slug, slug, target.canonical_slug],
    apply: () => {
      row.aliases = row.aliases.filter((a) => a.slug !== slug);
      if (target.canonical_slug !== slug) (target.aliases ||= []).push({ slug });
    }
  });
}

/** The slug a renamed row should carry: its title, plus "-phan-N" when the title does not say the season. */
export function preferredSlug(row, season) {
  const slug = normalizeTitle(row.title).replace(/\s+/g, '-') || 'movie';
  return has(season) && season > 1 && !has(seasonInText(row.title)) ? slug + '-phan-' + season : slug;
}

function gateRenameSlug(state, params) {
  const row = state.byId.get(params.movieId);
  if (!row) return fail('unknown-row');
  const slugSeason = seasonInSlug(row.canonical_slug);
  const current = rowSeason(row);
  if (!has(slugSeason) || !has(current) || slugSeason === current) return fail('slug-agrees');
  const evidence = seasonEvidence(row, current);
  if (evidence.against.some((name) => name !== 'slug')) return fail('season-unclear');
  if (evidence.support < 1) return fail('weak-evidence');
  if (row.sources.some((s) => available(s) && sourceSeason(s).season === slugSeason)) return fail('row-has-that-season');
  if (seasonInSlug(preferredSlug(row, current)) === slugSeason) return fail('title-names-slug-season');
  const siblings = state.seasonsOf(row).filter((other) => rowSeason(other) === slugSeason);
  if (siblings.length > 1) return fail('several-siblings');
  const sibling = siblings[0];
  return pass({
    sibling: sibling?.id ?? null, slugs: [row.canonical_slug, ...(sibling ? [sibling.canonical_slug] : [])],
    apply: () => {
      if (sibling) (sibling.aliases ||= []).push({ slug: row.canonical_slug });
      row.canonical_slug = preferredSlug(row, current);
    }
  });
}

function gateHideRow(state, params) {
  const row = state.byId.get(params.movieId);
  if (!row) return fail('unknown-row');
  if (row.sources.some(available)) return fail('has-available-source');
  return pass({ slugs: [row.canonical_slug], apply: () => { state.byId.delete(row.id); } });
}

function gateClearTmdb(state, params) {
  const row = state.byId.get(params.movieId);
  if (!row) return fail('unknown-row');
  if (!has(row.tmdb_id)) return fail('no-tmdb-id');
  if (row.tmdb_id_source !== 'inferred') return fail('not-inferred');
  const named = row.sources.filter((s) => s.provider === 'kkphim' && available(s)).map((s) => s.metadata || {})
    .filter((meta) => int(meta.tmdb_id) > 0 && ['movie', 'tv'].includes(meta.tmdb_type));
  if (!named.length) return fail('no-kkphim-tuple');
  if (named.some((meta) => int(meta.tmdb_id) === Number(row.tmdb_id) && meta.tmdb_type === row.tmdb_media_type)) return fail('a-source-agrees');
  return pass({ slugs: [row.canonical_slug], apply: () => state.clearTuple(row) });
}

const GATES = {
  set_season: gateSetSeason,
  move_source: gateMoveSource,
  merge_rows: gateMergeRows,
  fix_alias: gateFixAlias,
  rename_slug: gateRenameSlug,
  hide_row: gateHideRow,
  clear_tmdb: gateClearTmdb,
  report: () => fail('report-only'),
  none: () => fail('none')
};

/**
 * Check a group's proposal in order. Returns one verdict per action:
 * `{ action, ok, gate?, detail }`; a passed action is simulated before the next is checked.
 * Several set_season/rename_slug/move_source actions of one proposal see each other (a source the
 * proposal moves out no longer contradicts the row's new season). After a refused action (report
 * aside) the rest of the proposal is refused too.
 */
export function gateProposal(state, actions) {
  const pending = {
    movedSources: new Set(actions.filter((a) => a.type === 'move_source').map((a) => Number(a.sourceId))),
    renamed: new Set(actions.filter((a) => a.type === 'rename_slug').map((a) => a.movieId))
  };
  let failed = false;
  return actions.map((action) => {
    const gate = GATES[action.type];
    if (!gate) return { action, ok: false, gate: 'unknown-action' };
    // A later action was proposed on the premise of the earlier ones: once one fails, the rest wait.
    if (failed) return { action, ok: false, gate: 'earlier-action-failed' };
    const verdict = gate(state, action, pending);
    if (!verdict.ok) {
      if (!['report', 'none'].includes(action.type)) failed = true;
      return { action, ok: false, gate: verdict.gate };
    }
    const { apply, ok, ...detail } = verdict;
    apply();
    return { action, ok: true, detail };
  });
}

/**
 * Deterministic proposals for detectors that need no judgement: orphan rows, aliases and slugs
 * naming another season. Rows the model also looks at (season-marker / multi-season) are left to it.
 */
export function deterministicActions(group, family = () => []) {
  const actions = [];
  for (const row of group.rows) {
    const flags = new Set(group.flagged[row.id] || []);
    if (flags.has('orphan')) actions.push({ type: 'hide_row', movieId: row.id, reason: 'no available source' });
    if (flags.has('season-marker') || flags.has('multi-season')) continue;
    const season = rowSeason(row);
    if (flags.has('slug-season')) actions.push({ type: 'rename_slug', movieId: row.id, reason: 'slug names another season' });
    if (flags.has('alias-wrong')) {
      for (const alias of row.aliases || []) {
        const aliasSeason = seasonInSlug(alias.slug);
        if (!has(aliasSeason) || aliasSeason === season) continue;
        const sibling = [...group.rows, ...family(row)].find((other) => other.id !== row.id && other.media_type === row.media_type &&
          rowSeason(other) === aliasSeason && sameBase(other, row));
        if (sibling) actions.push({ type: 'fix_alias', slug: alias.slug, toMovieId: sibling.id, reason: 'alias names season ' + aliasSeason });
      }
    }
  }
  return actions;
}
