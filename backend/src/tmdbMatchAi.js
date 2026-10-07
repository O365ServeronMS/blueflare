import { castOverlap, actorKeys, seasonOf, tmdbEndpointFor } from './tmdbMatch.js';
import { fetchTmdb } from './tmdb.js';
import { MatchContentError } from './tmdbMatchGemini.js';

/**
 * "Gemini ranks real TMDB candidates, an independent gate decides".
 *
 * The model only chooses among candidates that TMDB itself returned; its choice
 * is never trusted on its own. `decideAiMatch` re-derives the evidence from the
 * catalog row and the candidate (cast overlap, exact name, year, size) so a
 * wrong-but-confident model answer is rejected by data it cannot influence.
 *
 * Leak rule: nothing here may read `tmdb_id`, `imdb_id` or `tmdb_match_*` of the
 * row being matched. `matchInput` is the only door a row goes through.
 */

export const MAX_AI_CANDIDATES = 8;
const SECONDARY_TYPE_SLOTS = 2;
const CAST_TOP = 30;
const PROMPT_LEVELS = Object.freeze({
  // 'standard' is what the first backtests were run with.
  compact: { cast: 5, altNames: 4, candidateOverview: 0, catalogOverview: 160 },
  standard: { cast: 8, altNames: 8, candidateOverview: 200, catalogOverview: 240 },
  rich: { cast: 10, altNames: 12, candidateOverview: 320, catalogOverview: 320 }
});

/** Row fields the matcher may see. Everything else (ids, match columns) is dropped on purpose. */
export const MATCH_INPUT_FIELDS = Object.freeze([
  'id', 'title', 'original_title', 'year', 'media_type', 'display_type',
  'countries', 'actors', 'episode_total', 'duration', 'overview'
]);

export function matchInput(row) {
  const input = {};
  for (const field of MATCH_INPUT_FIELDS) if (row?.[field] !== undefined) input[field] = row[field];
  return input;
}

// ---- names -----------------------------------------------------------------

/** Like comparableTitle but keeps CJK/Hangul letters, so 'Parasite'-style Latin keys stay identical. */
export function nameKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const isLatinName = (text) => /[A-Za-z]/.test(text) && !CJK.test(text);

const SEASON_ANYWHERE = /\s*\((?:Season|Phần|Part)\s*\d+\)/giu;

/**
 * Distinct names a catalog row goes by: the whole original_title, each comma/slash
 * separated piece, parenthesised alternatives, then the same for the Vietnamese title.
 * `whole` is true for an unsplit string: a comma can be part of a real title.
 */
export function catalogNames(row) {
  const out = [];
  const seen = new Set();
  const push = (text, source, whole) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const key = nameKey(clean);
    if (!key || /^\d+$/.test(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ text: clean, key, source, whole, latin: isLatinName(clean) });
  };
  for (const [source, raw] of [['original', row?.original_title], ['title', row?.title]]) {
    const stripped = String(raw || '').replace(SEASON_ANYWHERE, ' ');
    const parens = [...stripped.matchAll(/\(([^()]{2,})\)/g)].map((m) => m[1]);
    const bare = stripped.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const pieces = bare.split(/\s*[,;，、]\s*|\s+\/\s+|\s+\|\s+/u).filter(Boolean);
    push(bare, source, true);
    for (const piece of pieces) push(piece, source, false);
    for (const paren of parens) push(paren, source, false);
  }
  return out;
}

/** Queries to run: original-title pieces first, the unsplit string when it was split, a CJK name, the Vietnamese title as fallback. */
export function searchQueries(names, limit = 4) {
  const original = names.filter((n) => n.source === 'original');
  const pieces = original.filter((n) => n.latin && !n.whole).map((n) => n.text);
  const wholes = original.filter((n) => n.latin && n.whole).map((n) => n.text);
  const cjk = original.filter((n) => !n.latin).map((n) => n.text);
  const vi = names.filter((n) => n.source === 'title' && n.latin).map((n) => n.text);
  const latin = pieces.length ? [...pieces, ...wholes.filter((w) => w.length <= 50)] : wholes;
  const ordered = [...latin.slice(0, 3), ...cjk.slice(0, 1), ...(latin.length < 2 ? vi.slice(0, 1) : [])];
  const seen = new Set();
  return ordered.filter((q) => {
    const key = nameKey(q);
    if (!key || key.length < 2 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

export function countryLanguage(countries) {
  const slugs = (Array.isArray(countries) ? countries : []).map((c) => c?.slug);
  if (slugs.includes('nhat-ban')) return 'ja-JP';
  if (slugs.includes('han-quoc')) return 'ko-KR';
  if (slugs.some((s) => ['trung-quoc', 'hong-kong', 'dai-loan'].includes(s))) return 'zh-CN';
  return null;
}

const ASIAN_SLUGS = new Set(['nhat-ban', 'han-quoc', 'trung-quoc', 'hong-kong', 'dai-loan', 'thai-lan']);
export function isAsianRow(row) {
  return (Array.isArray(row?.countries) ? row.countries : []).some((c) => ASIAN_SLUGS.has(c?.slug));
}

// ---- catalog facts -----------------------------------------------------------

const firstInt = (text) => {
  const found = /\d+/.exec(String(text ?? ''));
  return found ? Number(found[0]) : null;
};

/** Everything the gate compares, derived from the (sanitised) row once. */
export function catalogFacts(row) {
  const names = catalogNames(row);
  const duration = firstInt(row?.duration);
  const episodes = firstInt(row?.episode_total);
  return {
    year: Number(row?.year) > 1800 ? Number(row.year) : null,
    mediaType: tmdbEndpointFor(row?.media_type),
    season: seasonOf(row?.original_title) ?? seasonOf(row?.title),
    names,
    nameKeys: new Map(names.map((n) => [n.key, n])),
    actorKeys: actorKeys(row?.actors),
    actorCount: actorKeys(row?.actors).size,
    episodes: episodes > 0 ? episodes : null,
    minutes: duration > 0 ? duration : null
  };
}

// ---- candidates ----------------------------------------------------------------

const yearOf = (date) => {
  const year = Number(String(date || '').slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : null;
};

/** Compact, storable candidate from a /movie|/tv detail body fetched with alternative_titles, translations, credits. */
export function compactCandidate(type, detail) {
  const isTv = type === 'tv';
  const names = new Set();
  const add = (value) => { if (typeof value === 'string' && value.trim()) names.add(value.trim()); };
  add(detail.title); add(detail.name); add(detail.original_title); add(detail.original_name);
  const alts = isTv ? detail.alternative_titles?.results : detail.alternative_titles?.titles;
  for (const alt of Array.isArray(alts) ? alts : []) add(alt?.title);
  let viTitle = null;
  for (const tr of Array.isArray(detail.translations?.translations) ? detail.translations.translations : []) {
    const value = isTv ? tr?.data?.name : tr?.data?.title;
    add(value);
    if (tr?.iso_639_1 === 'vi' && value) viTitle = value;
  }
  const runtime = isTv
    ? (Array.isArray(detail.episode_run_time) && detail.episode_run_time[0]) || detail.last_episode_to_air?.runtime || null
    : detail.runtime || null;
  return {
    key: type + ':' + detail.id,
    id: detail.id,
    type,
    title: (isTv ? detail.name : detail.title) || '',
    originalTitle: (isTv ? detail.original_name : detail.original_title) || '',
    viTitle,
    year: yearOf(isTv ? detail.first_air_date : detail.release_date),
    lastYear: isTv ? yearOf(detail.last_air_date) : null,
    seasons: isTv ? Number(detail.number_of_seasons) || null : null,
    episodes: isTv ? Number(detail.number_of_episodes) || null : null,
    runtime: Number(runtime) > 0 ? Number(runtime) : null,
    status: detail.status || null,
    originCountry: Array.isArray(detail.origin_country) ? detail.origin_country : [],
    overview: String(detail.overview || '').slice(0, 400),
    popularity: Number(detail.popularity) || 0,
    votes: Number(detail.vote_count) || 0,
    names: [...names],
    credits: { cast: (Array.isArray(detail.credits?.cast) ? detail.credits.cast : []).slice(0, CAST_TOP).map((c) => ({ name: c?.name })) }
  };
}

/** Pre-rank search hits so only the plausible ones cost a detail call. Pure. */
export function rankHits(hits, facts, limit = MAX_AI_CANDIDATES) {
  const scored = hits.map((hit) => {
    const hitNames = [hit.title, hit.name, hit.original_title, hit.original_name].map(nameKey).filter(Boolean);
    const exact = hitNames.some((k) => facts.nameKeys.has(k));
    const year = yearOf(hit.release_date || hit.first_air_date);
    const yearNear = facts.year && year ? (hit.type === 'movie' ? Math.abs(year - facts.year) <= 1 : year <= facts.year + 1) : false;
    const score = (exact ? 100 : 0) + (yearNear ? 30 : 0) + hit.queries * 8 - hit.bestRank * 2 + Math.log10(1 + (hit.vote_count || 0));
    return { hit, score };
  }).sort((a, b) => b.score - a.score);
  const picked = [];
  let secondary = 0;
  for (const { hit } of scored) {
    if (hit.type !== facts.mediaType) {
      if (secondary >= SECONDARY_TYPE_SLOTS) continue;
      secondary += 1;
    }
    picked.push(hit);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * TMDB client for the candidate pass: bounded concurrency, 429/5xx backoff, an
 * optional get/set cache (backtests replay the same evidence). 404 -> returns null.
 */
export function createTmdbClient(options = {}) {
  const fetcher = options.fetcher ?? fetchTmdb;
  const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 4));
  const retries = options.retries ?? 5;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cache = options.cache;
  const stats = { calls: 0, cached: 0, retried429: 0, errors: 0 };
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((resolve) => {
    if (active < concurrency) { active += 1; resolve(); } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  };

  async function get(path, extra = {}) {
    const cacheKey = path + '|' + (extra.language ?? '');
    const hit = cache ? await cache.get(cacheKey) : undefined;
    if (hit !== undefined) { stats.cached += 1; return hit; }
    await acquire();
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          stats.calls += 1;
          const body = await fetcher(path, { ...(options.tmdb || {}), ...extra });
          if (cache) await cache.set(cacheKey, body);
          return body;
        } catch (error) {
          if (error.status === 404) {
            if (cache) await cache.set(cacheKey, null);
            return null;
          }
          const retryable = error.status === 429 || error.status >= 500 || !error.status;
          if (!retryable || attempt >= retries) { stats.errors += 1; throw error; }
          if (error.status === 429) stats.retried429 += 1;
          const wait = error.retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt);
          await sleep(wait + Math.floor(Math.random() * 250));
        }
      }
    } finally {
      release();
    }
  }
  return { get, stats };
}

/**
 * Search TMDB by every name of the row, pre-rank the hits, then fetch details
 * (titles, translations, credits) for at most MAX_AI_CANDIDATES. Input must be a
 * `matchInput` row. Network errors propagate.
 */
export async function collectAiCandidates(inputRow, client, options = {}) {
  const facts = catalogFacts(inputRow);
  const queries = searchQueries(facts.names, options.maxQueries ?? 4);
  const primary = facts.mediaType;
  const other = primary === 'movie' ? 'tv' : 'movie';
  const lang = countryLanguage(inputRow.countries);
  const pool = new Map();
  const note = (type, results, query) => {
    (Array.isArray(results) ? results : []).slice(0, 10).forEach((hit, rank) => {
      const key = type + ':' + hit.id;
      const entry = pool.get(key) ?? { ...hit, type, queries: 0, bestRank: rank, seen: new Set() };
      if (!entry.seen.has(query)) { entry.queries += 1; entry.seen.add(query); }
      entry.bestRank = Math.min(entry.bestRank, rank);
      pool.set(key, entry);
    });
  };
  const search = async (type, query, extra = '', language) => {
    const body = await client.get('/search/' + type + '?query=' + encodeURIComponent(query) + extra, { language: language ?? 'en-US' });
    note(type, body?.results, query + extra + (language ?? ''));
  };
  for (const [index, query] of queries.entries()) {
    await search(primary, query);
    if (index === 0) {
      if (facts.year && primary === 'movie') await search('movie', query, '&year=' + facts.year);
      if (facts.year && primary === 'tv' && !facts.season) await search('tv', query, '&first_air_date_year=' + facts.year);
      await search(other, query);
    }
    if (lang && !isLatinName(query)) await search(primary, query, '', lang);
  }
  const chosen = rankHits([...pool.values()], facts, options.maxCandidates ?? MAX_AI_CANDIDATES);
  const candidates = [];
  for (const hit of chosen) {
    const detail = await client.get('/' + hit.type + '/' + hit.id + '?append_to_response=alternative_titles,translations,credits', { language: 'en-US' });
    if (detail) candidates.push(compactCandidate(hit.type, detail));
  }
  return { queries, candidates };
}

// ---- Gemini ranking ------------------------------------------------------------

export const RANK_SYSTEM_PROMPT = [
  'You match entries of a Vietnamese streaming catalog to the correct TheMovieDB (TMDB) entry.',
  'For each catalog entry you get a numbered list of TMDB candidates (all returned by TMDB search). Choose the ONE candidate that is the same work, or null.',
  'Rules:',
  '- A catalog TV row may be one season of a longer series; the series is still the right match. A season number in the title is the catalog\'s.',
  '- Reject remakes, reboots, sequels, spin-offs, specials, making-of and compilations unless they are clearly the same work. Different year or episode count is a strong sign of a different work.',
  '- Titles in the catalog are often romanised, translated, mixed or contain several alternative names separated by commas.',
  '- Use years, episode counts, runtime, cast, overview and alternative titles together. Do not guess: when no candidate is clearly the same work, answer null.',
  '- chosenId must be exactly one candidate id from that entry\'s list (e.g. "tv:1399"), or null.',
  '- confidence is 0..1. reasons is 1-3 short English phrases naming the evidence.',
  'Answer only the JSON array, one object per catalog entry, using the entry\'s movieKey.'
].join('\n');

export const RANK_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      movieKey: { type: 'STRING' },
      chosenId: { type: 'STRING', nullable: true },
      confidence: { type: 'NUMBER' },
      reasons: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['movieKey', 'chosenId', 'confidence', 'reasons']
  }
};

const clip = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** One prompt entry. Built from a sanitised row + compact candidates; carries no ids of the row itself. */
export function promptEntry(movieKey, inputRow, candidates, level = 'standard') {
  const facts = catalogFacts(inputRow);
  const size = PROMPT_LEVELS[level] ?? PROMPT_LEVELS.standard;
  return {
    movieKey,
    catalog: {
      title: inputRow.title || null,
      originalTitle: inputRow.original_title || null,
      year: facts.year,
      kind: facts.mediaType === 'movie' ? 'movie' : 'tv series (row may be one season)',
      season: facts.season,
      episodes: facts.episodes,
      minutes: facts.minutes,
      countries: (Array.isArray(inputRow.countries) ? inputRow.countries : []).map((c) => c?.name).filter(Boolean),
      actors: (Array.isArray(inputRow.actors) ? inputRow.actors : []).slice(0, size.cast),
      overview: clip(inputRow.overview, size.catalogOverview) || null
    },
    candidates: candidates.map((c) => ({
      id: c.key,
      title: c.title,
      originalTitle: c.originalTitle,
      viTitle: c.viTitle,
      year: c.year,
      lastYear: c.lastYear,
      seasons: c.seasons,
      episodes: c.episodes,
      runtime: c.runtime,
      origin: c.originCountry,
      otherNames: c.names.filter((n) => n !== c.title && n !== c.originalTitle).slice(0, size.altNames),
      cast: c.credits.cast.slice(0, size.cast).map((p) => p.name),
      overview: size.candidateOverview ? clip(c.overview, size.candidateOverview) || null : null
    }))
  };
}

export function buildRankPrompt(entries) {
  return 'Catalog entries and their TMDB candidates (JSON):\n' + JSON.stringify(entries);
}

/**
 * `thinkingBudget` (tokens, > 0) lets the model reason before answering; those tokens count as
 * output, so the output ceiling grows with it and with the number of entries.
 */
export function rankRequestBody(entries, options = {}) {
  const thinking = Number(options.thinkingBudget) > 0 ? Math.floor(Number(options.thinkingBudget)) : 0;
  const body = {
    systemInstruction: { parts: [{ text: RANK_SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildRankPrompt(entries) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: Math.min(65536, Math.max(8192, 1500 + 150 * entries.length + thinking)),
      responseMimeType: 'application/json',
      responseSchema: RANK_RESPONSE_SCHEMA
    }
  };
  if (thinking) body.generationConfig.thinkingConfig = { thinkingBudget: thinking };
  return body;
}

/** Characters of the system prompt + wrapper that every request pays for. */
export const RANK_PROMPT_OVERHEAD_CHARS = RANK_SYSTEM_PROMPT.length + 'Catalog entries and their TMDB candidates (JSON):\n'.length + 2;

/** Running chars-per-token ratio, corrected by the prompt token count every response reports. */
export function createTokenCalibration(initial = 3) {
  return { charsPerToken: initial, samples: 0 };
}

export function calibrateTokens(calibration, chars, promptTokens) {
  if (!(chars > 0) || !(promptTokens > 0)) return calibration;
  const ratio = Math.min(8, Math.max(1.2, chars / promptTokens));
  calibration.charsPerToken = calibration.samples ? calibration.charsPerToken * 0.6 + ratio * 0.4 : ratio;
  calibration.samples += 1;
  return calibration;
}

export const estimateTokens = (calibration, chars) => Math.ceil(chars / (calibration?.charsPerToken || 3));

/**
 * Turn a generateContent response into { movieKey -> {chosenId, confidence, reasons} }.
 * A chosenId outside that movie's candidate list becomes null (reason 'not-a-candidate'):
 * the model cannot invent an id. Entries the model skipped are simply absent.
 * Throws `makeError(message)` for refusals / unparsable output so the rotation tries the next model.
 */
export function parseRankResponse(json, entries, makeError = (m) => new Error(m)) {
  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason) throw makeError('gemini blocked prompt: ' + blockReason);
  const candidate = json?.candidates?.[0];
  if (!candidate) throw new Error('gemini response has no candidate');
  if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate.finishReason)) throw makeError('gemini refused: ' + candidate.finishReason);
  if (candidate.finishReason === 'MAX_TOKENS') throw makeError('gemini output truncated');
  const text = (Array.isArray(candidate.content?.parts) ? candidate.content.parts : [])
    .filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  let list;
  try { list = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw makeError('gemini returned invalid JSON'); }
  if (!Array.isArray(list)) throw makeError('gemini JSON is not an array');
  const allowed = new Map(entries.map((e) => [e.movieKey, new Set(e.candidates.map((c) => c.id))]));
  const out = new Map();
  for (const item of list) {
    const ids = allowed.get(item?.movieKey);
    if (!ids || out.has(item.movieKey)) continue;
    let chosenId = typeof item.chosenId === 'string' ? item.chosenId.trim() : null;
    const reasons = (Array.isArray(item.reasons) ? item.reasons : []).map((r) => clip(r, 160)).filter(Boolean).slice(0, 3);
    if (chosenId && !ids.has(chosenId)) {
      reasons.push('not-a-candidate');
      chosenId = null;
    }
    const confidence = Math.min(1, Math.max(0, Number(item.confidence) || 0));
    out.set(item.movieKey, { chosenId: chosenId || null, confidence, reasons });
  }
  return out;
}

/** One Gemini call for a batch of prompt entries via a `createTmdbMatchRotation` function. */
export async function rankBatch(rotation, entries, makeError = (m) => new MatchContentError(m), meta = {}, options = {}) {
  const prompt = buildRankPrompt(entries);
  meta.promptChars = prompt.length + RANK_SYSTEM_PROMPT.length;
  return rotation({
    text: prompt + RANK_SYSTEM_PROMPT,
    tokens: options.tokens,
    buildBody: () => rankRequestBody(entries, options),
    parse: (json) => parseRankResponse(json, entries, makeError),
    meta
  });
}

// ---- independent gate ------------------------------------------------------------

export const DEFAULT_AI_POLICY = Object.freeze({
  minOverlap: 2,
  minCatalogActors: 2,
  minNameKeyLength: 3,
  // Tier 2 refuses a row with no year: nothing else separates remakes.
  tier2RequireYear: true,
  tvEpisodeRatio: 1.5,
  runtimeTolerance: 0.15,
  // A TV row's year is its season's, so the series cannot start later than year+1.
  tvStartSlack: 1,
  // Optional: also refuse a TV candidate that ended long before the row's year.
  tvEndSlack: null,
  // Count a catalog actor whose name tokens are the same set in another order (Japanese/Korean order swaps).
  looseCast: false,
  // Tier 2 for rows that have >=2 actors but fail the overlap rule (cast list incomplete on TMDB).
  allowTier2WithCast: true,
  // Backtest (adversarial model): most wrong T1 picks were a sibling special/movie/season sharing the cast.
  t1RequireSize: true,
  // A catalog row of one family matched to a TMDB entry of the other family needs the exact name too.
  crossTypeNeedsName: true,
  // Only whole (unsplit) catalog names count as a name match when false.
  nameFromSplitPieces: true
});

export function yearOk(candidate, facts, policy = DEFAULT_AI_POLICY) {
  if (!facts.year || !candidate.year) return null; // unknown
  if (candidate.type === 'movie') return Math.abs(facts.year - candidate.year) <= 1;
  if (facts.year < candidate.year - policy.tvStartSlack) return false;
  if (policy.tvEndSlack != null && candidate.lastYear && facts.year > candidate.lastYear + policy.tvEndSlack) return false;
  return true;
}

/** true / false, or null when either side lacks the number. */
export function sizeOk(candidate, facts, policy = DEFAULT_AI_POLICY) {
  if (candidate.type === 'tv') {
    const checks = [];
    if (facts.season && candidate.seasons) checks.push(candidate.seasons >= facts.season);
    if (facts.episodes && candidate.episodes) checks.push(facts.episodes <= candidate.episodes * policy.tvEpisodeRatio);
    return checks.length ? checks.every(Boolean) : null;
  }
  if (facts.mediaType === 'tv' && facts.episodes > 2) return false; // a many-episode row is not a film
  if (facts.minutes && candidate.runtime) {
    return Math.abs(facts.minutes - candidate.runtime) <= candidate.runtime * policy.runtimeTolerance;
  }
  return null;
}

/** First catalog name found among the candidate's names, or null. */
export function exactNameMatch(candidate, facts, policy = DEFAULT_AI_POLICY) {
  for (const raw of candidate.names) {
    const key = nameKey(raw);
    const hit = key.length >= policy.minNameKeyLength || (CJK.test(raw) && key.length >= 2) ? facts.nameKeys.get(key) : null;
    if (hit && (policy.nameFromSplitPieces || hit.whole)) return { catalog: hit.text, tmdb: raw };
  }
  return null;
}

const tokenSet = (name) => nameKey(name).split(' ').filter(Boolean).sort().join(' ');
export function looseCastOverlap(facts, candidate) {
  const billed = new Set(candidate.credits.cast.map((p) => tokenSet(p.name)));
  const strict = castOverlap(facts.actorKeys, candidate.credits);
  let loose = 0;
  for (const key of facts.actorKeys) if (billed.has(tokenSet(key))) loose += 1;
  return Math.max(strict, loose);
}

function evaluate(candidate, facts, policy) {
  const overlap = policy.looseCast ? looseCastOverlap(facts, candidate) : castOverlap(facts.actorKeys, candidate.credits);
  return {
    key: candidate.key,
    overlap,
    name: exactNameMatch(candidate, facts, policy),
    year: yearOk(candidate, facts, policy),
    size: sizeOk(candidate, facts, policy)
  };
}

/**
 * Decide one catalog row. Pure.
 *  - `candidates`: compact candidates (see compactCandidate)
 *  - `choice`: { chosenId, confidence, reasons } from the model, or undefined if it skipped the row
 * Returns { status: 'verified'|'unverifiable'|'none', tier: 'T1'|'T2'|'T2x'|null, pick, reason, evidence }.
 * T1: model + cast overlap + year. T2: model + exact name + year + size + the only candidate that passes
 * (rows with <2 actors). T2x: same as T2 for a row that has actors but too little overlap.
 */
export function decideAiMatch({ input, candidates, choice, policy = DEFAULT_AI_POLICY }) {
  const facts = input.nameKeys ? input : catalogFacts(input);
  const list = Array.isArray(candidates) ? candidates : [];
  const done = (status, tier, pick, reason, evidence = {}) => ({ status, tier, pick, reason, evidence });
  if (!list.length) return done('none', null, null, 'no-candidates');
  if (!choice) return done('unverifiable', null, null, 'model-skipped');
  if (!choice.chosenId) return done('none', null, null, 'model-chose-none', { reasons: choice.reasons });
  const pick = list.find((c) => c.key === choice.chosenId);
  if (!pick) return done('none', null, null, 'not-a-candidate');

  const mine = evaluate(pick, facts, policy);
  const base = { ...mine, confidence: choice.confidence, actors: facts.actorCount };
  const hasCast = facts.actorCount >= policy.minCatalogActors;

  if (policy.crossTypeNeedsName && pick.type !== facts.mediaType && !mine.name) return done('unverifiable', null, pick, 'cross-type-no-name', base);
  if (hasCast && mine.overlap >= policy.minOverlap) {
    if (policy.t1RequireSize && mine.size === false) return done('unverifiable', null, pick, 'size-incompatible', base);
    if (mine.year === false) return done('unverifiable', null, pick, 'year-incompatible', base);
    if (pick.type === 'tv' && facts.season && pick.seasons && pick.seasons < facts.season) return done('unverifiable', null, pick, 'season-out-of-range', base);
    return done('verified', 'T1', pick, null, base);
  }
  if (hasCast && !policy.allowTier2WithCast) return done('unverifiable', null, pick, 'cast-no-overlap', base);

  // Tier 2: names + year + size, and no other candidate may pass the same test.
  const why = hasCast ? 'cast-no-overlap' : 'few-actors';
  if (!mine.name) return done('unverifiable', null, pick, why + '+no-name-match', base);
  if (mine.year === false) return done('unverifiable', null, pick, 'year-incompatible', base);
  if (mine.year == null && policy.tier2RequireYear) return done('unverifiable', null, pick, 'year-unknown', base);
  if (mine.size === false) return done('unverifiable', null, pick, 'size-incompatible', base);
  const rivals = list.filter((c) => c.key !== pick.key).map((c) => evaluate(c, facts, policy))
    .filter((e) => e.name && e.year !== false && e.size !== false && (e.year != null || !policy.tier2RequireYear));
  if (rivals.length) return done('unverifiable', null, pick, 'ambiguous-candidates', { ...base, rivals: rivals.map((r) => r.key) });
  return done('verified', hasCast ? 'T2x' : 'T2', pick, null, base);
}

/** Wilson lower bound helper for reports. */
export function wilsonLower(successes, total, z = 1.96) {
  if (!total) return 0;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return (centre - margin) / d;
}
