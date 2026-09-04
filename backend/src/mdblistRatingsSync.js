import { config } from './config.js';
import { mapLimit } from './concurrency.js';
import { fetchMdblistRatings, mdblistKeyId } from './mdblist.js';
import { collectRatingSlugs } from './ratingSlugs.js';

const SOURCES = ['tomatoes', 'audience'];
const REPOSITORY_DEPS = [
  ['listCandidates', 'listMdblistRatingCandidates'],
  ['recordResult', 'recordMdblistResult'],
  ['recordMiss', 'recordMdblistMiss'],
  ['reserveBudget', 'reserveMdblistBudget']
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
  return imdbId ? { provider: 'imdb', mediaType, id: imdbId } : null;
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

export async function syncMdblistRatings(sources, options = {}) {
  const startedAt = Date.now();
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

  const stats = {
    visible: 0,
    selected: 0,
    batches: 0,
    reserved: 0,
    spent: 0,
    matched: 0,
    partial: 0,
    unmatched: 0,
    tomatoes: 0,
    audience: 0,
    noId: 0,
    keysTotal: keys.length,
    keysTried: 0,
    keysDrained: 0,
    errors: {},
    declined: null,
    durationMs: 0,
    changedSlugs: []
  };
  const triedKeys = new Set();
  const done = () => {
    stats.keysTried = triedKeys.size;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  };

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

  const { states, tasks } = buildWork(candidates, Math.max(1, Math.floor(deps.idsPerRequest)));
  stats.batches = tasks.length;

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
      await deps.recordMiss(movie.id, 'no-id').catch(() => {});
      continue;
    }

    const completed = Number(tomatoes.attempted) + Number(audience.attempted);
    const values = [tomatoes.value, audience.value].filter((value) => value !== null);
    const status = completed === 2
      ? (values.length ? 'matched' : 'unmatched')
      : completed === 1 ? 'partial' : 'error';
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

  stats.changedSlugs = [...new Set(changed)];
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
  if (stats.declined) parts.push('declined=' + stats.declined);
  const errors = Object.entries(stats.errors);
  if (errors.length) parts.push('errors=' + errors.map(([reason, count]) => reason + 'x' + count).join(','));
  return parts.join(' ');
}
