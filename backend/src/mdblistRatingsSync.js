import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { fetchMdblistRatings, mdblistKeyId } from './mdblist.js';
import { collectRatingSlugs } from './ratingSlugs.js';

const SOURCES = ['tomatoes', 'audience'];
const REPOSITORY_DEPS = [
  ['listCandidates', 'listMdblistRatingCandidates'],
  ['recordResult', 'recordMdblistResult'],
  ['recordMiss', 'recordMdblistMiss'],
  ['reserveBudget', 'reserveMdblistBudget'],
  ['listBackfill', 'listMdblistBackfillCandidates']
];

async function resolveRepositoryDeps(options) {
  const resolved = {};
  const missing = REPOSITORY_DEPS.filter(([name]) => !options[name]);
  const repository = missing.length ? await import('./repository.js') : null;
  for (const [name, exported] of REPOSITORY_DEPS) {
    resolved[name] = options[name] || repository[exported];
  }
  return resolved;
}

function validTmdbId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function validImdbId(value) {
  const id = String(value ?? '').trim();
  return /^tt\d{7,}$/.test(id) ? id : null;
}

function lookupIdentity(movie) {
  const mediaType = movie.tmdb_media_type === 'movie' || movie.media_type === 'movie'
    ? 'movie'
    : 'show';
  const tmdbId = validTmdbId(movie.tmdb_id);
  if (tmdbId) return { provider: 'tmdb', mediaType, id: tmdbId };
  const imdbId = validImdbId(movie.imdb_id);
  if (imdbId) return { provider: 'imdb', mediaType, id: imdbId };
  // Last resort: an id guessed from the title. Good enough to look a rating up
  // by, never good enough to identify the row with.
  const guessed = validTmdbId(movie.tmdb_lookup_id);
  return guessed ? { provider: 'tmdb', mediaType, id: guessed } : null;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function buildWork(candidates, idsPerRequest) {
  const states = new Map();
  const groups = new Map();
  for (const movie of candidates) {
    const lookup = lookupIdentity(movie);
    const state = {
      movie,
      lookup,
      tomatoes: { attempted: false, value: null },
      audience: { attempted: false, value: null }
    };
    states.set(movie.id, state);
    if (!lookup) continue;
    const groupKey = lookup.provider + ':' + lookup.mediaType;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { provider: lookup.provider, mediaType: lookup.mediaType, members: new Map() });
    }
    const members = groups.get(groupKey).members;
    if (!members.has(lookup.id)) members.set(lookup.id, []);
    members.get(lookup.id).push(state);
  }

  const tasks = [];
  for (const group of groups.values()) {
    for (const ids of chunks([...group.members.keys()], idsPerRequest)) {
      for (const ratingSource of SOURCES) {
        tasks.push({ ...group, ids, ratingSource });
      }
    }
  }
  return { states, tasks };
}

function changedScore(previous, next) {
  const oldValue = previous === null || previous === undefined ? null : Number(previous);
  return oldValue !== next;
}

function newStats(keysTotal) {
  return {
    visible: 0, selected: 0, batches: 0, reserved: 0, spent: 0,
    matched: 0, partial: 0, unmatched: 0, tomatoes: 0, audience: 0, noId: 0,
    keysTotal, keysTried: 0, keysDrained: 0,
    errors: {}, declined: null, durationMs: 0, changedSlugs: [], cursor: null
  };
}

/**
 * Shared run context: the resolved key pool, repository deps, and a mutable
 * stats object. Both the demand-driven pass and the backfill walk build one of
 * these and then hand candidates to `processCandidates`, so there is a single
 * definition of budget spending and result recording.
 */
async function prepareRun(options = {}) {
  const keys = [...new Set(options.apiKeys ?? config.mdblistApiKeys)]
    .map((key) => String(key).trim())
    .filter(Boolean)
    .map((key) => ({ key, id: mdblistKeyId(key), drained: false }));
  const deps = {
    ...(await resolveRepositoryDeps(options)),
    fetchRatings: options.fetchRatings || fetchMdblistRatings,
    batchLimit: options.batchLimit ?? config.mdblistBatchLimit,
    idsPerRequest: options.idsPerRequest ?? config.mdblistIdsPerRequest,
    concurrency: options.concurrency ?? config.mdblistConcurrency,
    enabled: options.enabled ?? (config.mdblistEnabled && keys.length > 0)
  };
  const stats = newStats(keys.length);
  const triedKeys = new Set();
  const startedAt = Date.now();
  const done = () => {
    stats.keysTried = triedKeys.size;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  };
  return { keys, deps, stats, triedKeys, done };
}

/**
 * Fetch scores for a set of candidate rows and persist them. Returns the state
 * map so callers (the backfill) can see which rows were actually attempted
 * before budget ran out — the cursor must not skip un-attempted rows.
 */
async function processCandidates(candidates, ctx) {
  const { keys, deps, stats, triedKeys } = ctx;
  const { states, tasks } = buildWork(candidates, Math.max(1, Math.floor(deps.idsPerRequest)));
  stats.batches += tasks.length;

  async function fetchWithKeys(task) {
    for (const apiKey of keys) {
      if (apiKey.drained) continue;
      const budget = await deps.reserveBudget(apiKey.id, 1);
      if (!budget.granted) continue;
      stats.reserved += 1;
      triedKeys.add(apiKey.id);
      try {
        const result = await deps.fetchRatings({
          provider: task.provider,
          mediaType: task.mediaType,
          ratingSource: task.ratingSource,
          ids: task.ids
        }, { apiKey: apiKey.key });
        stats.spent += 1;
        return result;
      } catch (error) {
        stats.spent += 1;
        if (error?.code === 'MDBLIST_QUOTA' || error?.code === 'MDBLIST_AUTH') {
          if (!apiKey.drained) stats.keysDrained += 1;
          apiKey.drained = true;
          await deps.reserveBudget(apiKey.id, budget.ceiling).catch(() => {});
          continue;
        }
        throw error;
      }
    }
    const error = new Error('MDBList daily budget is exhausted');
    error.code = 'MDBLIST_BUDGET';
    throw error;
  }

  await mapLimit(tasks, Math.max(1, Math.floor(deps.concurrency)), async (task) => {
    try {
      const result = await fetchWithKeys(task);
      const byId = new Map(result.ratings.map((entry) => [String(entry.id), entry.rating]));
      for (const id of task.ids) {
        for (const state of task.members.get(id) || []) {
          state[task.ratingSource].attempted = true;
          state[task.ratingSource].value = byId.has(id) ? byId.get(id) : null;
        }
      }
    } catch (error) {
      const reason = error?.code === 'MDBLIST_BUDGET'
        ? 'budget'
        : error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error);
      stats.errors[reason] = (stats.errors[reason] || 0) + 1;
      if (error?.code === 'MDBLIST_BUDGET') stats.declined = 'budget-exhausted';
    }
  });

  const changed = [];
  for (const state of states.values()) {
    const { movie, lookup, tomatoes, audience } = state;
    if (!lookup) {
      stats.noId += 1;
      state.attempted = true;
      await deps.recordMiss(movie.id, 'no-id').catch(() => {});
      continue;
    }

    const completed = Number(tomatoes.attempted) + Number(audience.attempted);
    state.attempted = completed > 0;
    if (completed === 0) continue;

    const values = [tomatoes.value, audience.value].filter((value) => value !== null);
    const status = completed === 2
      ? (values.length ? 'matched' : 'unmatched')
      : 'partial';
    const changedResult = (
      (tomatoes.attempted && changedScore(movie.mdblist_tomatoes, tomatoes.value)) ||
      (audience.attempted && changedScore(movie.mdblist_audience, audience.value))
    );
    await deps.recordResult(movie.id, {
      status,
      tomatoesAttempted: tomatoes.attempted,
      tomatoes: tomatoes.value,
      audienceAttempted: audience.attempted,
      audience: audience.value,
      changed: changedResult
    });

    if (status === 'matched') stats.matched += 1;
    else if (status === 'partial') stats.partial += 1;
    else if (status === 'unmatched') stats.unmatched += 1;
    if (tomatoes.attempted && tomatoes.value !== null) stats.tomatoes += 1;
    if (audience.attempted && audience.value !== null) stats.audience += 1;
    if (changedResult) changed.push(movie.canonical_slug);
  }
  stats.changedSlugs = [...new Set([...stats.changedSlugs, ...changed])];
  return states;
}

export async function syncMdblistRatings(sources, options = {}) {
  const ctx = await prepareRun(options);
  const { deps, stats, done } = ctx;
  if (!deps.enabled) {
    stats.declined = 'disabled';
    return done();
  }

  const slugs = collectRatingSlugs(sources);
  stats.visible = slugs.length;
  if (!slugs.length) return done();
  const candidates = await deps.listCandidates(slugs, deps.batchLimit);
  stats.selected = candidates.length;
  if (!candidates.length) return done();

  await processCandidates(candidates, ctx);
  return done();
}

/**
 * One backfill pass: walk the catalog by id past the stored cursor and score
 * whatever the daily budget allows. The cursor only advances past rows that
 * were actually attempted, so a pass cut short by budget resumes exactly where
 * it stopped rather than skipping un-scored rows.
 *
 * The walk never retires. Rows become eligible *behind* the cursor all the
 * time — a title lookup resolves an id for a row the walk already passed, or
 * new content lands — so reaching the end wraps back to the start instead of
 * marking the job done. An idle lap is close to free: the TTL filter excludes
 * everything checked recently, so it costs one indexed query and no API call.
 */
export async function backfillMdblistRatings(options = {}) {
  const ctx = await prepareRun(options);
  const { deps, stats, done } = ctx;
  const listBackfill = options.listBackfill ?? deps.listBackfill;
  if (!deps.enabled) {
    stats.declined = 'disabled';
    return done();
  }

  const cursor = String(options.cursor ?? '');
  const limit = Math.max(1, Math.floor(options.batchLimit ?? config.mdblistBackfillBatchLimit));

  let candidates = await listBackfill(cursor, limit);
  let wrapped = false;
  if (!candidates.length && cursor) {
    wrapped = true;
    candidates = await listBackfill('', limit);
  }
  const startCursor = wrapped ? '' : cursor;

  stats.selected = candidates.length;
  stats.wrapped = wrapped;
  if (!candidates.length) {
    // Nothing due anywhere: park the cursor at the start so the next pass is a
    // single query rather than a walk to the end before it can wrap again.
    stats.cursor = { next: '', wrapped };
    return done();
  }

  const states = await processCandidates(candidates, ctx);

  // Advance only to the last id that was attempted; leave budget-declined rows
  // (and everything after them) for the next pass by keeping the cursor there.
  let lastAttempted = startCursor;
  for (const movie of candidates) {
    const state = states.get(movie.id);
    if (!state?.attempted) break;
    lastAttempted = movie.id;
  }
  stats.cursor = { next: lastAttempted, wrapped };
  return done();
}

export function formatMdblistStats(stats) {
  const parts = [
    'visible=' + stats.visible,
    'selected=' + stats.selected,
    'batches=' + stats.batches,
    'reserved=' + stats.reserved,
    'spent=' + stats.spent,
    'matched=' + stats.matched,
    'partial=' + stats.partial,
    'unmatched=' + stats.unmatched,
    'tomatoes=' + stats.tomatoes,
    'audience=' + stats.audience,
    'noId=' + stats.noId,
    'keys=' + stats.keysTried + '/' + stats.keysTotal,
    'drained=' + stats.keysDrained,
    'durationMs=' + stats.durationMs
  ];
  if (stats.cursor) parts.push('wrapped=' + Boolean(stats.cursor.wrapped));
  if (stats.declined) parts.push('declined=' + stats.declined);
  const errors = Object.entries(stats.errors);
  if (errors.length) parts.push('errors=' + errors.map(([reason, count]) => reason + 'x' + count).join(','));
  return parts.join(' ');
}
