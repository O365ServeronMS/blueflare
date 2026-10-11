import assert from 'node:assert/strict';
import test from 'node:test';

const { inferSeasonFromTmdb } = await import('../src/tmdbSeasonInfer.js');
const { refreshSeasonInference } = await import('../src/tmdbSeasonInferSync.js');
const { resolveSeason, planTmdbIdentityWith } = await import('../src/tmdbIdentity.js');

const row = (over = {}) => ({ title: 'Phim A', original_title: 'Show A', canonical_slug: 'phim-a', year: 2020, episode_total: '12', ...over });
const season = (season_number, episode_count, air_date) => ({ season_number, episode_count, air_date });
const show = (...seasons) => ({ seasons });

// ---- inferSeasonFromTmdb ---------------------------------------------------------------------

test('a show with exactly one real season gives that season; season 0 (specials) is ignored', () => {
  const out = inferSeasonFromTmdb(row(), show(season(0, 5, '2019-01-01'), season(1, 12, '2020-03-01')));
  assert.equal(out.season, 1);
  assert.deepEqual(out.tmdbSeason, { episodes: 12, air_date: '2020-03-01' });
});

test('Bleach-like: S1 of 366 episodes with catalog 366 is accepted', () => {
  const out = inferSeasonFromTmdb(row({ title: 'Bleach', year: 2004, episode_total: '366', canonical_slug: 'bleach' }),
    show(season(0, 3, '2005-01-01'), season(1, 366, '2004-10-05')));
  assert.equal(out.season, 1);
});

test('several seasons: the one agreeing in year (+-1) and episode count (<=1.25) wins', () => {
  const s = show(season(1, 12, '2015-01-01'), season(2, 13, '2020-06-01'), season(3, 30, '2020-09-01'));
  assert.equal(inferSeasonFromTmdb(row({ year: 2021, episode_total: '12' }), s).season, 2);
});

test('zero candidates: no-season-fits; two candidates: ambiguous', () => {
  const near = show(season(1, 12, '2020-01-01'), season(2, 20, '2020-09-01'));
  // 16 vs 12 is 1.33 (> 1.25) but only 4 apart, so it is not a hard episode gap either
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '16' }), show(season(1, 12, '2020-01-01'), season(2, 11, '2015-01-01'))).reason, 'no-season-fits');
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '12' }), show(season(1, 12, '2020-01-01'), season(2, 12, '2021-01-01'))).reason, 'ambiguous');
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '12' }), near).season, 1);
});

test('hard rejects: no year, too few episodes, year gap of 2-3, episode gap', () => {
  const s = show(season(1, 12, '2020-01-01'), season(2, 12, '2024-01-01'));
  assert.equal(inferSeasonFromTmdb(row({ year: null }), s).reason, 'no-year');
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '2' }), s).reason, 'too-few-episodes');
  assert.equal(inferSeasonFromTmdb(row({ episode_total: null }), s).reason, 'too-few-episodes');
  for (const gap of [2, 3]) {
    const one = show(season(1, 12, `${2020 + gap}-01-01`));
    assert.equal(inferSeasonFromTmdb(row({ year: 2020 }), one).reason, 'year-gap');
    assert.equal(inferSeasonFromTmdb(row({ year: 2020 }), show(season(1, 12, `${2020 + gap}-01-01`), season(2, 12, `${2020 + gap + 3}-01-01`))).reason, 'year-gap');
  }
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '12' }), show(season(1, 30, '2020-01-01'))).reason, 'episode-gap');
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '12' }), show(season(1, 30, '2020-01-01'), season(2, 40, '2021-01-01'))).reason, 'episode-gap');
  // a gap of 5 or fewer episodes, or of 25% or less, is tolerated
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '12' }), show(season(1, 17, '2020-01-01'))).season, 1);
  assert.equal(inferSeasonFromTmdb(row({ episode_total: '100' }), show(season(1, 124, '2020-01-01'))).season, 1);
});

test('rows whose title or slug already names a season are not this pass business', () => {
  const s = show(season(1, 12, '2020-01-01'), season(2, 12, '2020-06-01'));
  // "Thành Phố Bí Mật (Phần 2)" must never become S1
  const secret = row({ title: 'Thành Phố Bí Mật (Phần 2)', canonical_slug: 'thanh-pho-bi-mat-phan-2' });
  const out = inferSeasonFromTmdb(secret, show(season(1, 12, '2020-01-01')));
  assert.equal(out.season, null);
  assert.equal(inferSeasonFromTmdb(row({ canonical_slug: 'x-phan-2-2020' }), s).season, null);
});

test('marker-conflict: an explicit number in the names that differs from the chosen season', () => {
  const one = show(season(1, 12, '2020-01-01'));
  // "Dạ Lẫm Thần Thám 1" (trailing 1) must not become S2
  const da = row({ title: 'Dạ Lẫm Thần Thám 1', canonical_slug: 'da-lam-than-tham-1' });
  assert.equal(inferSeasonFromTmdb(da, show(season(1, 30, '2015-01-01'), season(2, 12, '2020-01-01'))).reason, 'marker-conflict');
  assert.equal(inferSeasonFromTmdb(da, one).season, 1); // same number: fine
  for (const title of ['Show Season 2', 'Show 2nd Season', 'Show Mùa 3', 'Show Quyển 2', 'Show Volume 2', 'Show Part 2']) {
    assert.equal(inferSeasonFromTmdb(row({ title }), one).reason, 'marker-conflict', title);
  }
  assert.equal(inferSeasonFromTmdb(row({ original_title: 'Show Season 2' }), one).reason, 'marker-conflict');
  assert.equal(inferSeasonFromTmdb(row({ canonical_slug: 'show-season-2' }), one).reason, 'marker-conflict');
  // a four digit number is a year, not a season
  assert.equal(inferSeasonFromTmdb(row({ title: 'Show 2020' }), one).season, 1);
});

test('one-episode special is rejected', () => {
  const special = row({ title: 'Hồ Sơ Của Lord El-Melloi II: Tập Đặc Biệt', canonical_slug: 'ho-so-cua-lord-elmelloi-ii-su-kien-tap-dac-biet', episode_total: '1' });
  assert.equal(inferSeasonFromTmdb(special, show(season(1, 13, '2020-01-01'), season(2, 1, '2020-06-01'))).reason, 'too-few-episodes');
});

// ---- plumbing --------------------------------------------------------------------------------

test('resolveSeason: explicit season is the last resort and is validated', () => {
  const plain = { title: 'X', canonical_slug: 'x' };
  assert.deepEqual(resolveSeason(plain, 'tv', 5, 3), { season: 3 });
  assert.deepEqual(resolveSeason(plain, 'tv', null, 3), { season: 3 });
  assert.equal(resolveSeason(plain, 'tv', 5, 0).blocked, 'season-invalid');
  assert.equal(resolveSeason(plain, 'tv', 5, 1.5).blocked, 'season-invalid');
  assert.equal(resolveSeason(plain, 'tv', 2, 3).blocked, 'season-out-of-range');
  // stored season and title marker win over the explicit one
  assert.deepEqual(resolveSeason({ ...plain, tmdb_season_number: 2 }, 'tv', 5, 3), { season: 2 });
  assert.deepEqual(resolveSeason({ title: 'X (Phần 4)', canonical_slug: 'x' }, 'tv', 5, 3), { season: 4 });
  assert.deepEqual(resolveSeason(plain, 'movie', null, 3), { season: null });
  assert.equal(resolveSeason(plain, 'tv', 5).blocked, 'season-unknown');
});

test('planTmdbIdentityWith passes input.season to the planner', async () => {
  const target = { id: 't', canonical_slug: 'x', title: 'X', catalog_state: 'ready', tmdb_id: null };
  const db = { query: async (sql) => ({ rows: sql.includes('WHERE id=$1') ? [target] : [] }) };
  const plan = await planTmdbIdentityWith(db, 't', { tmdbId: 9, mediaType: 'tv', numberOfSeasons: 4, season: 3 });
  assert.deepEqual([plan.action, plan.season], ['assign', 3]);
  const blocked = await planTmdbIdentityWith(db, 't', { tmdbId: 9, mediaType: 'tv', numberOfSeasons: 4 });
  assert.equal(blocked.reason, 'season-unknown');
});

// ---- worker pass -----------------------------------------------------------------------------

const settings = { tmdbSeasonInferMode: 'apply', tmdbSeasonInferBatch: 100, tmdbMatchConcurrency: 2 };
const rows = () => [
  { id: 'a', canonical_slug: 'a', title: 'A', year: 2020, episode_total: '12', candidate_tmdb_id: '10', ai_run_id: 'run-1' },
  { id: 'b', canonical_slug: 'b', title: 'B', year: 2020, episode_total: '12', candidate_tmdb_id: '10', ai_run_id: null },
  { id: 'c', canonical_slug: 'c', title: 'C', year: 2020, episode_total: '1', candidate_tmdb_id: '11', ai_run_id: null },
  { id: 'd', canonical_slug: 'd', title: 'D', year: 2020, episode_total: '12', candidate_tmdb_id: '12', ai_run_id: null }
];

function harness(extra = {}) {
  const calls = { get: [], assign: [], record: [] };
  const shows = {
    10: { number_of_seasons: 2, seasons: [season(1, 30, '2010-01-01'), season(2, 12, '2020-01-01')] },
    11: { number_of_seasons: 2, seasons: [season(1, 30, '2010-01-01'), season(2, 12, '2020-01-01')] },
    12: null
  };
  const deps = {
    settings: { ...settings, ...(extra.settings || {}) },
    mode: extra.mode,
    client: { get: async (path) => { calls.get.push(path); return shows[Number(path.split('/').pop())]; } },
    list: async () => rows(),
    assign: async (id, input, options) => {
      calls.assign.push({ id, input, options });
      if (options.mode === 'dry-run') return { action: 'planned', plan: 'assign', survivorSlug: id };
      return id === 'a' ? { action: 'assigned', survivorSlug: 'a' } : { action: 'merged', survivorSlug: 'b', dropSlug: 'b-old' };
    },
    record: async (id, input, reason, options) => { calls.record.push({ id, reason, options }); }
  };
  return { deps, calls };
}

test('refreshSeasonInference off does nothing', async () => {
  const { deps, calls } = harness({ mode: 'off' });
  const stats = await refreshSeasonInference(deps);
  assert.equal(stats.checked, 0);
  assert.equal(calls.get.length + calls.assign.length, 0);
});

test('refreshSeasonInference apply: fetches each id once, assigns inferred seasons with evidence, records declines', async () => {
  const { deps, calls } = harness();
  const stats = await refreshSeasonInference(deps);
  assert.deepEqual(calls.get.sort(), ['/tv/10', '/tv/11', '/tv/12']);
  assert.equal(calls.assign.length, 2);
  assert.deepEqual(calls.assign[0].input, { tmdbId: 10, mediaType: 'tv', numberOfSeasons: 2, season: 2 });
  assert.equal(calls.assign[0].options.source, 'inferred');
  assert.deepEqual(calls.assign[0].options.evidence, { pass: 'season-infer', season: 2, tmdbSeason: { episodes: 12, air_date: '2020-01-01' }, aiRun: 'run-1' });
  assert.equal('aiRun' in calls.assign[1].options.evidence, false);
  assert.deepEqual([stats.checked, stats.assigned, stats.merged, stats.blocked], [4, 1, 1, 2]);
  assert.deepEqual(stats.reasons, { 'too-few-episodes': 1, 'tmdb-show-missing': 1 });
  assert.deepEqual(stats.slugs.sort(), ['a', 'b', 'b-old']);
  assert.deepEqual(calls.record.map((r) => [r.id, r.reason, r.options.evidence.pass]), [['c', 'too-few-episodes', 'season-infer'], ['d', 'tmdb-show-missing', 'season-infer']]);
});

test('refreshSeasonInference dry-run writes nothing and plans through the assign path', async () => {
  const { deps, calls } = harness({ mode: 'dry-run' });
  const stats = await refreshSeasonInference(deps);
  assert.equal(calls.record.length, 0);
  assert.deepEqual(calls.assign.map((c) => c.options.mode), ['dry-run', 'dry-run']);
  assert.deepEqual([stats.checked, stats.planned, stats.assigned, stats.blocked], [4, 2, 0, 2]);
  assert.deepEqual(stats.slugs, []);
});

test('refreshSeasonInference counts a TMDB error without declining the row', async () => {
  const { deps, calls } = harness();
  deps.client = { get: async () => { throw new Error('boom'); } };
  const stats = await refreshSeasonInference(deps);
  assert.deepEqual([stats.errors, stats.assigned, stats.reasons['tmdb-error']], [4, 0, 4]);
  assert.equal(calls.record.length + calls.assign.length, 0);
});

test('refreshSeasonInference without a TMDB key does nothing', async () => {
  const { deps } = harness();
  delete deps.client;
  const stats = await refreshSeasonInference(deps);
  assert.equal(stats.skipped, 'no-tmdb');
});
