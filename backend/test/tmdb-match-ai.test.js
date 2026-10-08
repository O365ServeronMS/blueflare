import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogFacts, catalogNames, collectAiCandidates, compactCandidate, createTmdbClient, decideAiMatch,
  matchInput, nameKey, parseRankResponse, promptEntry, buildRankPrompt, rankRequestBody, searchQueries, yearOk, sizeOk,
  DEFAULT_AI_POLICY, calibrateTokens, createTokenCalibration, estimateTokens
} from '../src/tmdbMatchAi.js';

const cand = (over = {}) => ({
  key: 'tv:1', id: 1, type: 'tv', title: 'Moonlight Drawn by Clouds', originalTitle: '구르미 그린 달빛', viTitle: null,
  year: 2016, lastYear: 2016, seasons: 1, episodes: 18, runtime: 60, status: 'Ended', originCountry: ['KR'],
  overview: '', popularity: 1, votes: 10, names: ['Moonlight Drawn by Clouds', '구르미 그린 달빛', 'Mây Họa Ánh Trăng'],
  credits: { cast: [{ name: 'Park Bo-gum' }, { name: 'Kim Yoo-jung' }, { name: 'Jung Jin-young' }] }, ...over
});
const row = (over = {}) => ({
  id: 'x', title: 'Mây Họa Ánh Trăng', original_title: 'Moonlight Drawn By Clouds', year: 2016, media_type: 'tv',
  countries: [{ name: 'Hàn Quốc', slug: 'han-quoc' }], actors: [], episode_total: '18', duration: '60 phút/tập', ...over
});
const ai = (id = 'tv:1') => ({ chosenId: id, confidence: 0.9, reasons: [] });

test('nameKey keeps CJK, folds Latin diacritics like comparableTitle', () => {
  assert.equal(nameKey('Đường  Đến Hạnh-Phúc!'), 'duong den hanh phuc');
  assert.equal(nameKey('구르미 그린 달빛'), '구르미 그린 달빛');
  assert.equal(nameKey('Ｆｕｌｌ'), 'full');
});

test('catalogNames splits commas, parentheses and drops season suffixes', () => {
  const names = catalogNames({ original_title: 'A Show, Other Name (Season 2)', title: 'Tên (Alt Name)' });
  const keys = names.map((n) => n.key);
  assert.ok(keys.includes('a show other name') && keys.includes('a show') && keys.includes('other name') && keys.includes('alt name'));
  assert.deepEqual(searchQueries(names), ['A Show', 'Other Name', 'A Show, Other Name']);
});

test('matchInput drops every identity and match column', () => {
  const dirty = { ...row(), tmdb_id: 5, imdb_id: 'tt1', tmdb_match_id: 9, tmdb_match_status: 'verified', tmdb_media_type: 'tv', tmdb_season_number: 2, tmdb_lookup_id: '7', omdb_imdb_id: 'tt2' };
  const clean = matchInput(dirty);
  for (const key of Object.keys(clean)) assert.ok(!/tmdb|imdb/.test(key), key);
  const prompt = buildRankPrompt([promptEntry('m1', clean, [cand()])]) + JSON.stringify(rankRequestBody([]));
  assert.ok(!/tt1|tt2/.test(prompt));
});

test('tier 2 verifies a cast-less row on exact name + year + size', () => {
  const verdict = decideAiMatch({ input: row(), candidates: [cand()], choice: ai() });
  assert.equal(verdict.status, 'verified');
  assert.equal(verdict.tier, 'T2');
  assert.equal(verdict.evidence.name.tmdb, 'Moonlight Drawn by Clouds');
});

test('tier 2 refuses: name, year, size, no year, rival', () => {
  const go = (r, candidates, choice = ai()) => decideAiMatch({ input: r, candidates, choice });
  assert.equal(go(row(), [cand({ names: ['Something Else'], title: 'Something Else', originalTitle: 'x' })]).reason, 'few-actors+no-name-match');
  assert.equal(go(row({ year: 2010 }), [cand()]).reason, 'year-incompatible');
  assert.equal(go(row({ year: null }), [cand()]).reason, 'year-unknown');
  assert.equal(go(row({ episode_total: '40' }), [cand()]).reason, 'size-incompatible');
  assert.equal(go(row({ original_title: 'Moonlight Drawn By Clouds (Season 3)' }), [cand()]).reason, 'size-incompatible');
  const rival = cand({ key: 'tv:2', id: 2 });
  const verdict = go(row(), [cand(), rival]);
  assert.equal(verdict.reason, 'ambiguous-candidates');
  assert.deepEqual(verdict.evidence.rivals, ['tv:2']);
});

test('tier 1 needs two shared actors and a compatible year', () => {
  const r = row({ actors: ['Park Bo-gum', 'Kim Yoo-jung', 'Someone Else'], original_title: 'Totally Different Name', title: 'Khác' });
  assert.deepEqual(decideAiMatch({ input: r, candidates: [cand()], choice: ai() }).tier, 'T1');
  assert.equal(decideAiMatch({ input: row({ ...r, year: 2000 }), candidates: [cand()], choice: ai() }).reason, 'year-incompatible');
  const oneShared = row({ actors: ['Park Bo-gum', 'Nobody One'], original_title: 'Totally Different Name', title: 'Khác' });
  assert.equal(decideAiMatch({ input: oneShared, candidates: [cand()], choice: ai() }).status, 'unverifiable');
  // actors present but overlap short, names agree: T2x unless the policy forbids it
  const named = row({ actors: ['Park Bo-gum', 'Nobody One'] });
  assert.equal(decideAiMatch({ input: named, candidates: [cand()], choice: ai() }).tier, 'T2x');
  assert.equal(decideAiMatch({ input: named, candidates: [cand()], choice: ai(), policy: { ...DEFAULT_AI_POLICY, allowTier2WithCast: false } }).reason, 'cast-no-overlap');
});

test('loose cast counts swapped given/family order only when enabled', () => {
  const r = row({ actors: ['Bo-gum Park', 'Yoo-jung Kim'], original_title: 'Other', title: 'Khác' });
  assert.equal(decideAiMatch({ input: r, candidates: [cand()], choice: ai() }).tier, null);
  assert.equal(decideAiMatch({ input: r, candidates: [cand()], choice: ai(), policy: { ...DEFAULT_AI_POLICY, looseCast: true } }).tier, 'T1');
});

test('no candidates -> none; model null -> none; model skipped -> unverifiable; bad id -> none', () => {
  assert.equal(decideAiMatch({ input: row(), candidates: [], choice: ai() }).status, 'none');
  assert.equal(decideAiMatch({ input: row(), candidates: [cand()], choice: { chosenId: null, confidence: 0.1, reasons: [] } }).reason, 'model-chose-none');
  assert.equal(decideAiMatch({ input: row(), candidates: [cand()], choice: undefined }).status, 'unverifiable');
  assert.equal(decideAiMatch({ input: row(), candidates: [cand()], choice: ai('tv:999') }).reason, 'not-a-candidate');
});

test('year and size rules per media type', () => {
  const movie = cand({ type: 'movie', key: 'movie:1', year: 2010, runtime: 100, seasons: null, episodes: null });
  assert.equal(yearOk(movie, { year: 2011 }), true);
  assert.equal(yearOk(movie, { year: 2012 }), false);
  assert.equal(yearOk(movie, { year: null }), null);
  assert.equal(sizeOk(movie, { minutes: 114 }), true);
  assert.equal(sizeOk(movie, { minutes: 120 }), false);
  assert.equal(sizeOk(movie, { minutes: null }), null);
  const series = cand({ year: 2010 });
  assert.equal(yearOk(series, { year: 2009 }), true);
  assert.equal(yearOk(series, { year: 2008 }), false);
  assert.equal(yearOk(series, { year: 2030 }), true);
  assert.equal(yearOk(series, { year: 2030 }, { ...DEFAULT_AI_POLICY, tvEndSlack: 3 }), false);
  assert.equal(sizeOk(series, { episodes: 27, season: null }), true);
  assert.equal(sizeOk(series, { episodes: 28, season: null }), false);
  assert.equal(sizeOk(series, { episodes: null, season: null }), null);
});

test('parseRankResponse: a chosenId outside the candidates becomes null, skipped rows are absent', () => {
  const entries = [{ movieKey: 'a', candidates: [{ id: 'tv:1' }, { id: 'movie:2' }] }, { movieKey: 'b', candidates: [{ id: 'tv:3' }] }];
  const text = JSON.stringify([
    { movieKey: 'a', chosenId: 'tv:3', confidence: 2, reasons: ['x'] },
    { movieKey: 'z', chosenId: 'tv:1', confidence: 1, reasons: [] }
  ]);
  const chat = (content, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content } }] });
  const out = parseRankResponse(chat(text), entries);
  assert.equal(out.size, 1);
  assert.deepEqual(out.get('a'), { chosenId: null, confidence: 1, reasons: ['x', 'not-a-candidate'] });
  assert.throws(() => parseRankResponse(chat('nope'), entries), /invalid JSON/);
  assert.throws(() => parseRankResponse(chat('[]', 'length'), entries), /truncated/);
  // {results:[...]} wrapper, code fences and a leading <think> block are accepted
  const wrapped = '<think>hmm</think>\n```json\n' + JSON.stringify({ results: [{ movieKey: 'b', chosenId: 'tv:3', confidence: 0.9, reasons: [] }] }) + '\n```';
  assert.equal(parseRankResponse(chat(wrapped), entries).get('b').chosenId, 'tv:3');
});

test('compactCandidate flattens names, translations and the top cast', () => {
  const detail = {
    id: 7, name: 'Show', original_name: 'ショー', first_air_date: '2020-04-01', number_of_seasons: 2, number_of_episodes: 24,
    episode_run_time: [24], alternative_titles: { results: [{ title: 'Alt' }] },
    translations: { translations: [{ iso_639_1: 'vi', data: { name: 'Chương trình' } }] },
    credits: { cast: Array.from({ length: 40 }, (_, i) => ({ name: 'P' + i })) }
  };
  const c = compactCandidate('tv', detail);
  assert.equal(c.key, 'tv:7');
  assert.equal(c.viTitle, 'Chương trình');
  assert.deepEqual(c.names.sort(), ['Alt', 'Chương trình', 'Show', 'ショー'].sort());
  assert.equal(c.credits.cast.length, 30);
  assert.equal(c.runtime, 24);
});

test('tmdb client retries 429 with backoff and returns null on 404', async () => {
  let n = 0;
  const sleeps = [];
  const client = createTmdbClient({
    sleep: async (ms) => sleeps.push(ms),
    fetcher: async (path) => {
      if (path === '/gone') throw Object.assign(new Error('x'), { status: 404 });
      n += 1;
      if (n < 3) throw Object.assign(new Error('x'), { status: 429, retryAfterMs: 10 });
      return { ok: true };
    }
  });
  assert.deepEqual(await client.get('/a'), { ok: true });
  assert.equal(sleeps.length, 2);
  assert.equal(await client.get('/gone'), null);
  assert.equal(client.stats.retried429, 2);
});

test('tmdb client never runs more than 4 requests at once', async () => {
  let live = 0;
  let peak = 0;
  const client = createTmdbClient({
    concurrency: 99,
    fetcher: async () => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live -= 1; return {}; }
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => client.get('/p' + i)));
  assert.equal(peak, 4);
});

test('collectAiCandidates searches both families, caps candidates and never sends catalog ids', async () => {
  const seen = [];
  const hits = (type, n) => ({ results: Array.from({ length: n }, (_, i) => ({ id: i + 1, [type === 'tv' ? 'name' : 'title']: 'Hit ' + i, popularity: 1, vote_count: i })) });
  const client = createTmdbClient({
    fetcher: async (path) => {
      seen.push(path);
      if (path.startsWith('/search/tv')) return hits('tv', 10);
      if (path.startsWith('/search/movie')) return hits('movie', 10);
      const [, type, id] = path.split(/[/?]/);
      return { id: Number(id), [type === 'tv' ? 'name' : 'title']: 'Hit', credits: { cast: [] } };
    }
  });
  const input = matchInput({ ...row({ year: 2016 }), tmdb_id: 99, imdb_id: 'tt0000099' });
  const { candidates } = await collectAiCandidates(input, client);
  assert.ok(candidates.length <= 8);
  assert.ok(candidates.filter((c) => c.type === 'movie').length <= 2);
  assert.ok(seen.every((p) => !/tt0000099|=99(&|$)/.test(p)));
  assert.ok(seen.some((p) => p.includes('first_air_date_year=2016')));
});

test('catalogFacts reads season, episodes and minutes', () => {
  const facts = catalogFacts({ original_title: 'Foo (Season 4)', year: '2020', media_type: 'tv', episode_total: '12', duration: '45 Phút/Tập', actors: ['A', 'B'] });
  assert.equal(facts.season, 4);
  assert.equal(facts.episodes, 12);
  assert.equal(facts.minutes, 45);
  assert.equal(facts.actorCount, 2);
  assert.equal(facts.mediaType, 'tv');
});

test('T1 refuses a size-incompatible sibling and a cross-family pick without an exact name', () => {
  const actors = ['Park Bo-gum', 'Kim Yoo-jung'];
  const r = row({ actors, original_title: 'Other Name', title: 'Khác' });
  assert.equal(decideAiMatch({ input: { ...r, episode_total: '60' }, candidates: [cand()], choice: ai() }).reason, 'size-incompatible');
  const special = cand({ type: 'movie', key: 'movie:9', seasons: null, episodes: null, runtime: 90, year: 2016 });
  assert.equal(decideAiMatch({ input: { ...r, episode_total: '1', duration: '90 phút' }, candidates: [special], choice: ai('movie:9') }).reason, 'cross-type-no-name');
  assert.equal(decideAiMatch({ input: { ...r, episode_total: '1', duration: '90 phút' }, candidates: [special], choice: ai('movie:9'), policy: { ...DEFAULT_AI_POLICY, crossTypeNeedsName: false } }).tier, 'T1');
});

test('prompt levels: rich carries more alt names and overview than standard, compact less; standard is unchanged', () => {
  const long = 'x'.repeat(500);
  const c = cand({ overview: long, names: Array.from({ length: 20 }, (_, i) => 'Alt ' + i) });
  const at = (level) => promptEntry('m1', { ...matchInput(row()), overview: long }, [c], level);
  const size = (level) => JSON.stringify(at(level)).length;
  assert.ok(size('compact') < size('standard') && size('standard') < size('rich'));
  assert.equal(at('standard').candidates[0].overview.length, 200);
  assert.equal(at('rich').candidates[0].overview.length, 320);
  assert.equal(at('standard').candidates[0].otherNames.length, 8);
  assert.equal(at('rich').candidates[0].otherNames.length, 12);
  assert.equal(at('compact').candidates[0].overview, null);
  assert.deepEqual(promptEntry('m1', { ...matchInput(row()), overview: long }, [c]), at('standard'), 'default level');
});

test('rankRequestBody: reasoning only when asked, output ceiling grows with it and with the entries', () => {
  assert.deepEqual(rankRequestBody([]).reasoning, { enabled: false });
  assert.deepEqual(rankRequestBody([], { thinkingBudget: 0 }).reasoning, { enabled: false });
  const body = rankRequestBody(Array.from({ length: 40 }, (_, i) => ({ movieKey: 'm' + i })), { thinkingBudget: 4096 });
  assert.deepEqual(body.reasoning, { max_tokens: 4096 });
  assert.equal(body.max_tokens, 1500 + 150 * 40 + 4096);
  assert.equal(rankRequestBody([]).max_tokens, 8192);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
});

test('token calibration follows the reported prompt tokens and ignores nonsense', () => {
  const cal = createTokenCalibration();
  assert.equal(estimateTokens(cal, 3000), 1000);
  calibrateTokens(cal, 6000, 1000);
  assert.equal(cal.charsPerToken, 6);
  calibrateTokens(cal, 4000, 1000);
  assert.ok(cal.charsPerToken > 4 && cal.charsPerToken < 6);
  const before = cal.charsPerToken;
  calibrateTokens(cal, 0, 10); calibrateTokens(cal, 10, 0); calibrateTokens(cal, 10, null);
  assert.equal(cal.charsPerToken, before);
  calibrateTokens(cal, 1e9, 1);
  assert.ok(cal.charsPerToken <= 8, 'clamped');
});
