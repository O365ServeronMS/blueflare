import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actorKeys,
  castOverlap,
  DEFAULT_POLICY,
  decideMatch,
  findCastVerifiedMatch,
  searchTitles,
  seasonOf,
  yearCompatible
} from '../src/tmdbMatch.js';
import { scorePolicy, wilson } from '../tools/tmdb-match-backtest.mjs';

const BASE = 'https://tmdb.test/3';

/** Routes by path; unknown paths 404 like TMDB. */
function router(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.replace('/3', '');
    const query = new URL(url).searchParams.get('query');
    calls.push(query ? path + '?query=' + query : path);
    const key = query ? path + '?query=' + query : path;
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
  return { fetchImpl, calls, options: { apiKey: 'k', baseUrl: BASE, fetchImpl } };
}

const credits = (...names) => ({ cast: names.map((name, index) => ({ id: 100 + index, name, order: index })), crew: [] });

test('seasonOf reads the catalog suffix', () => {
  assert.equal(seasonOf('The Bear (Season 3)'), 3);
  assert.equal(seasonOf('Kinh dị (phần 2)'), 2);
  assert.equal(seasonOf('The Bear'), null);
});

test('searchTitles strips the season suffix and adds the first comma segment once', () => {
  assert.deepEqual(searchTitles('The Bear (Season 3)'), ['The Bear']);
  assert.deepEqual(searchTitles('Go For It, Nakamura!'), ['Go For It, Nakamura!', 'Go For It']);
  assert.deepEqual(searchTitles(''), []);
});

test('castOverlap ignores case, accents and punctuation, and counts each actor once', () => {
  const keys = actorKeys(['Song Sam-dong', 'Béatrice Dalle', 'Nobody', 'Nobody']);
  assert.equal(castOverlap(keys, credits('SONG SAM DONG', 'Beatrice Dalle', 'Someone Else')), 2);
  assert.equal(castOverlap(keys, {}), 0);
});

test('castOverlap only looks at the first 30 billed', () => {
  const names = Array.from({ length: 40 }, (_, i) => 'Actor ' + i);
  assert.equal(castOverlap(actorKeys(['Actor 35']), credits(...names)), 0);
  assert.equal(castOverlap(actorKeys(['Actor 5']), credits(...names)), 1);
});

test('yearCompatible: movies within a year, tv only needs to have started already', () => {
  assert.equal(yearCompatible('movie', 2010, 2011), true);
  assert.equal(yearCompatible('movie', 2010, 2015), false);
  assert.equal(yearCompatible('tv', 2023, 2016), true);
  assert.equal(yearCompatible('tv', 2010, 2020), false);
  assert.equal(yearCompatible('movie', null, 1999), true);
});

test('decideMatch: needs enough catalog actors and enough overlap', () => {
  const ctx = { actorCount: 3, endpoint: 'movie', year: 2020 };
  assert.equal(decideMatch([{ id: 1, year: 2020, overlap: 1 }], ctx).reason, 'no-overlap');
  assert.equal(decideMatch([], ctx).reason, 'no-candidates');
  assert.equal(decideMatch([{ id: 1, year: 2020, overlap: 5 }], { ...ctx, actorCount: 1 }).status, 'unverifiable');
  const ok = decideMatch([{ id: 1, year: 2020, overlap: 2 }], ctx);
  assert.equal(ok.status, 'verified');
  assert.equal(ok.pick.id, 1);
});

test('decideMatch: a same-cast candidate from the wrong year is rejected for movies only', () => {
  const candidates = [{ id: 9, year: 2005, overlap: 6 }];
  assert.equal(decideMatch(candidates, { actorCount: 6, endpoint: 'movie', year: 2020 }).status, 'none');
  assert.equal(decideMatch(candidates, { actorCount: 6, endpoint: 'tv', year: 2020 }).status, 'verified');
});

test('decideMatch: higher overlap wins, an equal overlap is a tie', () => {
  const ctx = { actorCount: 5, endpoint: 'tv', year: 2020 };
  assert.equal(decideMatch([{ id: 1, overlap: 2 }, { id: 2, overlap: 4 }], ctx).pick.id, 2);
  const tie = decideMatch([{ id: 1, overlap: 3, votes: 9 }, { id: 2, overlap: 3, votes: 1 }], ctx);
  assert.equal(tie.status, 'unverifiable');
  assert.equal(tie.reason, 'tie');
  assert.equal(decideMatch([{ id: 1, overlap: 3, votes: 9 }, { id: 2, overlap: 3, votes: 1 }], ctx, { ...DEFAULT_POLICY, requireUnique: false }).pick.id, 1);
});

const movieRow = { original_title: 'Man of the Year', media_type: 'movie', year: 2006, actors: ['Robin Williams', 'Laura Linney', 'Lewis Black'] };

test('findCastVerifiedMatch verifies a title hit by shared cast and returns its credits', async () => {
  const { options, calls } = router({
    '/search/movie?query=Man of the Year': { results: [{ id: 11, title: 'Man of the Year', release_date: '2006-10-13', vote_count: 500 }] },
    '/movie/11/credits': credits('Robin Williams', 'Laura Linney', 'Christopher Walken')
  });
  const result = await findCastVerifiedMatch(movieRow, options);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.match, { mediaType: 'movie', tmdbId: 11 });
  assert.equal(result.evidence.overlap, 2);
  assert.equal(result.credits.cast[0].name, 'Robin Williams');
  // One search and one credits call: the credits are reused, not fetched again.
  assert.deepEqual(calls, ['/search/movie?query=Man of the Year', '/movie/11/credits']);
});

test('findCastVerifiedMatch does not fetch credits for a candidate the year gate rejects', async () => {
  const { options, calls } = router({
    '/search/movie?query=Man of the Year': { results: [{ id: 12, title: 'Man of the Year', release_date: '1995-01-01' }] }
  });
  const result = await findCastVerifiedMatch(movieRow, options);
  assert.equal(result.status, 'none');
  assert.deepEqual(calls, ['/search/movie?query=Man of the Year']);
});

test('findCastVerifiedMatch rejects a title match with no shared cast', async () => {
  const { options } = router({
    '/search/movie?query=Man of the Year': { results: [{ id: 13, title: 'Man of the Year', release_date: '2006-01-01' }] },
    '/movie/13/credits': credits('Nobody Known')
  });
  const result = await findCastVerifiedMatch(movieRow, options);
  assert.equal(result.status, 'none');
  assert.equal(result.match, null);
  assert.equal(result.credits, null);
});

const tvRow = { original_title: 'Taxi Driver (Season 4)', media_type: 'tv', year: 2023, actors: ['Lee Je-Hoon', 'Kim Eui-Sung'] };

test('findCastVerifiedMatch: a season beyond the series length is not a match', async () => {
  const { options } = router({
    '/search/tv?query=Taxi Driver': { results: [{ id: 21, name: 'Taxi Driver', first_air_date: '2021-04-09' }] },
    '/tv/21/credits': credits('Lee Je-hoon', 'Kim Eui-sung'),
    '/tv/21': { number_of_seasons: 2 }
  });
  const result = await findCastVerifiedMatch(tvRow, options);
  assert.equal(result.status, 'none');
  assert.equal(result.evidence.reason, 'season-out-of-range');
});

test('findCastVerifiedMatch: a tv season row resolves to the series identity', async () => {
  const { options } = router({
    '/search/tv?query=Taxi Driver': { results: [{ id: 21, name: 'Taxi Driver', first_air_date: '2021-04-09' }] },
    '/tv/21/credits': credits('Lee Je-hoon', 'Kim Eui-sung'),
    '/tv/21': { number_of_seasons: 4 }
  });
  const result = await findCastVerifiedMatch(tvRow, options);
  assert.deepEqual(result.match, { mediaType: 'tv', tmdbId: 21 });
});

test('findCastVerifiedMatch lets a TMDB failure propagate so it is recorded as an error', async () => {
  const options = { apiKey: 'k', baseUrl: BASE, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) };
  await assert.rejects(() => findCastVerifiedMatch(movieRow, options), /HTTP 500/);
});

test('wilson interval brackets the observed rate and shrinks with n', () => {
  const [lowSmall, highSmall] = wilson(9, 10);
  const [lowBig, highBig] = wilson(900, 1000);
  assert.ok(lowSmall < 0.9 && highSmall > 0.9);
  assert.ok(highBig - lowBig < highSmall - lowSmall);
  assert.deepEqual(wilson(0, 0), [0, 0]);
});

test('scorePolicy scores a verified pick against ground truth', () => {
  const collected = (id) => ({ endpoint: 'movie', actorCount: 3, candidates: [{ id, year: 2020, overlap: 3 }] });
  const rows = [
    { year: 2020, truth: 7, collected: collected(7) },
    { year: 2020, truth: 8, collected: collected(9) },
    { year: 2020, truth: 5, collected: { endpoint: 'movie', actorCount: 3, candidates: [] } }
  ];
  const s = scorePolicy(rows, DEFAULT_POLICY);
  assert.equal(s.accepted, 2);
  assert.equal(s.correct, 1);
  assert.equal(s.wrong, 1);
  assert.equal(s.recall, 1 / 3);
});
