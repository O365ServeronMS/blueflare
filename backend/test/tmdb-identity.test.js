import assert from 'node:assert/strict';
import test from 'node:test';

// The database tests run only against a throwaway database (TEST_DATABASE_URL, name must contain
// "test"); db.js reads DATABASE_URL at import time, so it is set before anything is imported.
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

const identity = await import('../src/tmdbIdentity.js');
const { chooseSurvivor, mergeGuard, needsSeasonCount, resolveSeason, validateIdentity } = identity;

// ---- pure rules ------------------------------------------------------------------------------

test('validateIdentity accepts only positive ids and movie|tv', () => {
  assert.deepEqual(validateIdentity({ tmdbId: '12', mediaType: 'tv' }), { id: 12, mediaType: 'tv' });
  assert.equal(validateIdentity({ tmdbId: 0, mediaType: 'tv' }), null);
  assert.equal(validateIdentity({ tmdbId: 5, mediaType: 'person' }), null);
});

test('movies never have a season; series need an evident one and are never guessed', () => {
  assert.deepEqual(resolveSeason({ title: 'X', canonical_slug: 'x' }, 'movie'), { season: null });
  assert.deepEqual(resolveSeason({ title: 'X (Phần 3)', canonical_slug: 'x' }, 'tv', 5), { season: 3 });
  assert.deepEqual(resolveSeason({ title: 'X', canonical_slug: 'x-phan-2-2024' }, 'tv', 4), { season: 2 });
  assert.deepEqual(resolveSeason({ title: 'X', canonical_slug: 'x', tmdb_season_number: 4 }, 'tv'), { season: 4 });
  assert.deepEqual(resolveSeason({ title: 'X', canonical_slug: 'x' }, 'tv', 1), { season: 1 });
  assert.equal(resolveSeason({ title: 'X', canonical_slug: 'x' }, 'tv', 6).blocked, 'season-unknown');
  assert.equal(resolveSeason({ title: 'X', canonical_slug: 'x' }, 'tv').blocked, 'season-unknown');
  assert.equal(resolveSeason({ title: 'X (Phần 9)', canonical_slug: 'x' }, 'tv', 3).blocked, 'season-out-of-range');
  assert.equal(needsSeasonCount({ title: 'X', canonical_slug: 'x' }, 'tv'), true);
  assert.equal(needsSeasonCount({ title: 'X (Phần 2)', canonical_slug: 'x' }, 'tv'), false);
  assert.equal(needsSeasonCount({ title: 'X', canonical_slug: 'x' }, 'movie'), false);
});

const row = (over) => ({ id: 'id-' + Math.random(), providers: [], created_at: '2024-01-01T00:00:00Z', ...over });

test('survivor: most providers, then KKPhim, then fuller metadata, then oldest', () => {
  const two = row({ id: 'a', providers: ['kkphim', 'nguonc'] });
  const one = row({ id: 'b', providers: ['kkphim'] });
  assert.deepEqual([chooseSurvivor([one, two]).survivor.id, chooseSurvivor([one, two]).reason], ['a', 'more-providers']);
  const nguonc = row({ id: 'c', providers: ['nguonc'] });
  assert.deepEqual([chooseSurvivor([nguonc, one]).survivor.id, chooseSurvivor([nguonc, one]).reason], ['b', 'has-kkphim']);
  const full = row({ id: 'd', providers: ['kkphim'], overview: 'x', actors: ['a'], year: 2000 });
  assert.deepEqual([chooseSurvivor([one, full]).survivor.id, chooseSurvivor([one, full]).reason], ['d', 'fuller-metadata']);
  const older = row({ id: 'e', providers: ['kkphim'], created_at: '2020-01-01T00:00:00Z' });
  assert.deepEqual([chooseSurvivor([one, older]).survivor.id, chooseSurvivor([one, older]).reason], ['e', 'oldest-row']);
  assert.equal(chooseSurvivor([one, older, two]).drops.length, 2);
});

test('an inferred identity is not folded into a row with another imdb id or a distant year', () => {
  assert.equal(mergeGuard({ imdb_id: 'tt1' }, { imdb_id: 'tt2' }, 'inferred'), 'imdb-differs');
  assert.equal(mergeGuard({ year: 2000 }, { year: 2003 }, 'inferred'), 'year-differs');
  assert.equal(mergeGuard({ year: 2000 }, { year: 2001 }, 'inferred'), null);
  assert.equal(mergeGuard({ year: 2000 }, { year: 2010 }, 'provider'), null);
});

test('promoteVerifiedMatches: off does nothing; dry-run counts plans and pages by lastId', async () => {
  const calls = [];
  const rows = [
    { id: 'a', tmdb_match_id: '5', tmdb_match_media_type: 'movie', title: 'A', canonical_slug: 'a' },
    { id: 'b', tmdb_match_id: '6', tmdb_match_media_type: 'tv', title: 'B', canonical_slug: 'b' }
  ];
  const outcomes = { a: { action: 'planned', plan: 'merge' }, b: { action: 'blocked', reason: 'season-unknown' } };
  const assign = async (id, input, options) => { calls.push({ id, input, options }); return outcomes[id]; };
  const list = async () => rows;
  assert.equal((await identity.promoteVerifiedMatches({ mode: 'off', assign, list })).checked, 0);
  const stats = await identity.promoteVerifiedMatches({ mode: 'dry-run', limit: 10, assign, list, seasonsFor: async () => 4 });
  assert.equal(stats.checked, 2);
  assert.equal(stats.planned.merge, 1);
  assert.equal(stats.blocked, 1);
  assert.deepEqual(stats.reasons, { 'season-unknown': 1 });
  assert.equal(stats.lastId, 'b');
  assert.equal(calls[1].input.numberOfSeasons, 4);
  assert.equal(calls[0].input.numberOfSeasons, null);
  assert.equal(calls[1].options.mode, 'dry-run');
});

// ---- database (throwaway DB) -----------------------------------------------------------------

let pool;
let migrate;
let seq = 0;

async function movie(over = {}) {
  seq += 1;
  const slug = over.slug || 'film-' + seq;
  const values = {
    title: 'Film ' + seq, normalized_title: 'film ' + seq, media_type: 'single', display_type: 'phim-le', year: 2020, ...over
  };
  delete values.slug;
  const columns = ['canonical_slug', ...Object.keys(values)];
  const result = await pool.query(
    `INSERT INTO movies (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
    [slug, ...Object.values(values)]
  );
  return result.rows[0];
}
async function source(movieId, provider, slug) {
  const { rows } = await pool.query(
    'INSERT INTO movie_provider_sources (movie_id, provider, provider_movie_id, provider_slug, priority, metadata) VALUES ($1,$2,$3,$3,1,$4::jsonb) RETURNING id',
    [movieId, provider, provider + ':' + slug, '{}']);
  return rows[0].id;
}
async function user() {
  seq += 1;
  return (await pool.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id', [`u${seq}@t.test`, 'x'])).rows[0].id;
}
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const count = async (sql, params) => Number((await one(sql, params)).n);

async function reset() {
  await pool.query('TRUNCATE movies, users, movie_merges, tmdb_identity_changes, image_assets CASCADE');
}

test.before(async () => {
  if (!TEST_DB) return;
  ({ pool } = await import('../src/db.js'));
  ({ migrate } = await import('../src/db.js'));
  await migrate();
});
test.after(async () => { if (pool) await pool.end(); });

dbTest('assign writes the identity as pending and logs it; dry-run writes nothing', async () => {
  await reset();
  const m = await movie({ tmdb_identity_status: 'ineligible' });
  const dry = await identity.assignTmdbIdentity(m.id, { tmdbId: 100, mediaType: 'movie' }, { mode: 'dry-run' });
  assert.equal(dry.action, 'planned');
  assert.equal(dry.plan, 'assign');
  assert.equal((await one('SELECT tmdb_id FROM movies WHERE id=$1', [m.id])).tmdb_id, null);
  assert.equal(await count('SELECT count(*) n FROM tmdb_identity_changes'), 0);
  assert.equal((await identity.planTmdbIdentity(m.id, { tmdbId: 100, mediaType: 'movie' })).action, 'assign');

  const result = await identity.assignTmdbIdentity(m.id, { tmdbId: 100, mediaType: 'movie' }, { evidence: { tier: 1 } });
  assert.equal(result.action, 'assigned');
  const after = await one('SELECT * FROM movies WHERE id=$1', [m.id]);
  assert.deepEqual([Number(after.tmdb_id), after.tmdb_media_type, after.tmdb_season_number, after.tmdb_id_source, after.tmdb_identity_status],
    [100, 'movie', null, 'inferred', 'pending']);
  assert.equal((await identity.assignTmdbIdentity(m.id, { tmdbId: 100, mediaType: 'movie' })).action, 'noop');
  const other = await identity.assignTmdbIdentity(m.id, { tmdbId: 101, mediaType: 'movie' });
  assert.deepEqual([other.action, other.reason], ['blocked', 'row-has-other-identity']);

  const undone = await identity.undoTmdbIdentity(result.changeId);
  assert.equal(undone.action, 'undone');
  const reverted = await one('SELECT * FROM movies WHERE id=$1', [m.id]);
  assert.deepEqual([reverted.tmdb_id, reverted.tmdb_id_source, reverted.tmdb_identity_status], [null, null, 'ineligible']);
  assert.equal((await identity.undoTmdbIdentity(result.changeId)).reason, 'already-undone');
});

dbTest('a series with no evident season is blocked, logged once and left alone', async () => {
  await reset();
  const m = await movie({ media_type: 'series', title: 'Archer' });
  const input = { tmdbId: 200, mediaType: 'tv', numberOfSeasons: 5 };
  const first = await identity.assignTmdbIdentity(m.id, input);
  assert.deepEqual([first.action, first.reason], ['blocked', 'season-unknown']);
  await identity.assignTmdbIdentity(m.id, input);
  assert.equal(await count("SELECT count(*) n FROM tmdb_identity_changes WHERE kind='blocked'"), 1);
  assert.equal((await one('SELECT tmdb_id FROM movies WHERE id=$1', [m.id])).tmdb_id, null);
  const marked = await movie({ media_type: 'series', title: 'Archer (Phần 2)', slug: 'archer-phan-2' });
  assert.equal((await identity.assignTmdbIdentity(marked.id, input)).action, 'assigned');
  assert.equal((await one('SELECT tmdb_season_number s FROM movies WHERE id=$1', [marked.id])).s, 2);
});

dbTest('two rows of one page merge: sources, favorites, history, aliases, reviews move; undo restores', async () => {
  await reset();
  const holder = await movie({ slug: 'dune', tmdb_id: 300, tmdb_media_type: 'movie', tmdb_id_source: 'provider', tmdb_identity_status: 'verified', created_at: '2024-02-01' });
  const target = await movie({ slug: 'dune-nguonc', overview: 'only on target', created_at: '2024-01-01' });
  const holderSource = await source(holder.id, 'kkphim', 'dune');
  const targetSource = await source(target.id, 'nguonc', 'dune-nguonc');
  await pool.query("INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ('dune-old', $1)", [target.id]);
  const [u1, u2, u3] = [await user(), await user(), await user()];
  // u1 favorited both, u2 only the target; history: u1 newer on target, u3 only on holder
  await pool.query('INSERT INTO user_favorites (user_id, movie_id) VALUES ($1,$2),($1,$3),($4,$3)', [u1, holder.id, target.id, u2]);
  await pool.query("INSERT INTO user_history (user_id, movie_id, watched_at, episode_key) VALUES ($1,$2,'2024-03-01','h'),($1,$3,'2024-04-01','t'),($4,$2,'2024-03-05','h3')", [u1, holder.id, target.id, u3]);
  await pool.query("INSERT INTO movie_reviews (movie_id, tmdb_review_id, content, content_hash) VALUES ($1,'r1','a','h1'),($2,'r1','a','h1'),($2,'r2','b','h2')", [holder.id, target.id]);

  const dry = await identity.assignTmdbIdentity(target.id, { tmdbId: 300, mediaType: 'movie' }, { mode: 'dry-run' });
  assert.deepEqual([dry.action, dry.plan], ['planned', 'merge']);
  assert.equal(await count('SELECT count(*) n FROM movies'), 2);

  const result = await identity.assignTmdbIdentity(target.id, { tmdbId: 300, mediaType: 'movie' });
  assert.equal(result.action, 'merged');
  // equal provider count (1 each), one has kkphim -> the KKPhim holder survives
  assert.equal(result.survivorId, holder.id);
  assert.equal(result.dropId, target.id);
  assert.equal(await count('SELECT count(*) n FROM movies'), 1);
  const survivor = await one('SELECT * FROM movies WHERE id=$1', [holder.id]);
  assert.equal(survivor.overview, 'only on target');
  assert.equal(survivor.primary_provider, 'nguonc');
  assert.equal(await count('SELECT count(*) n FROM movie_provider_sources WHERE movie_id=$1', [holder.id]), 2);
  assert.deepEqual((await pool.query("SELECT slug FROM movie_slug_aliases WHERE movie_id=$1 ORDER BY slug", [holder.id])).rows.map((r) => r.slug), ['dune-nguonc', 'dune-old']);
  assert.equal(await count('SELECT count(*) n FROM user_favorites WHERE movie_id=$1', [holder.id]), 2); // u1 once, u2
  const history = (await pool.query('SELECT user_id, episode_key FROM user_history WHERE movie_id=$1', [holder.id])).rows;
  assert.equal(history.length, 2);
  assert.equal(history.find((h) => h.user_id === u1).episode_key, 't'); // newer one wins
  assert.equal(await count('SELECT count(*) n FROM movie_reviews WHERE movie_id=$1', [holder.id]), 2); // r1 not duplicated, r2 moved

  const undone = await identity.undoTmdbIdentity(result.changeId);
  assert.equal(undone.action, 'undone');
  assert.equal(await count('SELECT count(*) n FROM movies'), 2);
  const back = await one('SELECT * FROM movies WHERE id=$1', [target.id]);
  assert.equal(back.canonical_slug, 'dune-nguonc');
  assert.equal(back.tmdb_id, null);
  const restoredHolder = await one('SELECT * FROM movies WHERE id=$1', [holder.id]);
  assert.equal(restoredHolder.overview, null);
  assert.equal(restoredHolder.primary_provider, holder.primary_provider);
  assert.equal(await count('SELECT count(*) n FROM movie_provider_sources WHERE movie_id=$1', [target.id]), 1);
  assert.equal((await one('SELECT movie_id FROM movie_provider_sources WHERE id=$1', [targetSource])).movie_id, target.id);
  assert.equal((await one('SELECT movie_id FROM movie_provider_sources WHERE id=$1', [holderSource])).movie_id, holder.id);
  assert.equal(await count("SELECT count(*) n FROM movie_slug_aliases WHERE slug='dune-nguonc'"), 0);
  assert.equal(await count("SELECT count(*) n FROM movie_slug_aliases WHERE slug='dune-old' AND movie_id=$1", [target.id]), 1);
  assert.deepEqual((await pool.query('SELECT user_id FROM user_favorites WHERE movie_id=$1 ORDER BY user_id', [target.id])).rows.map((r) => r.user_id).sort(), [u1, u2].sort());
  assert.equal(await count('SELECT count(*) n FROM user_favorites WHERE movie_id=$1', [holder.id]), 1);
  assert.equal((await one('SELECT episode_key FROM user_history WHERE movie_id=$1 AND user_id=$2', [holder.id, u1])).episode_key, 'h');
  assert.equal((await one('SELECT episode_key FROM user_history WHERE movie_id=$1 AND user_id=$2', [target.id, u1])).episode_key, 't');
  assert.equal(await count('SELECT count(*) n FROM movie_reviews WHERE movie_id=$1', [target.id]), 1); // r2 is back; the duplicate r1 was dropped with the row (re-fetchable)
  // the restored title is not promoted again
  await pool.query("UPDATE movies SET tmdb_match_status='verified', tmdb_match_id=300, tmdb_match_media_type='movie' WHERE id=$1", [target.id]);
  assert.equal((await identity.listPromotionCandidates(10)).length, 0);
});

dbTest('the row that lacks the id survives when it has more providers; the identity moves to it', async () => {
  await reset();
  const holder = await movie({ slug: 'solo', tmdb_id: 400, tmdb_media_type: 'movie', tmdb_id_source: 'provider', tmdb_identity_status: 'verified', created_at: '2024-02-01' });
  const target = await movie({ slug: 'both', created_at: '2024-01-01' });
  await source(holder.id, 'nguonc', 'solo');
  await source(target.id, 'kkphim', 'both');
  await source(target.id, 'nguonc', 'both-n');
  const result = await identity.assignTmdbIdentity(target.id, { tmdbId: 400, mediaType: 'movie' });
  assert.deepEqual([result.action, result.survivorId, result.droppedSlug ?? result.dropSlug], ['merged', target.id, 'solo']);
  const survivor = await one('SELECT * FROM movies WHERE id=$1', [target.id]);
  assert.deepEqual([Number(survivor.tmdb_id), survivor.tmdb_id_source, survivor.tmdb_identity_status], [400, 'provider', 'verified']);
  await identity.undoTmdbIdentity(result.changeId);
  assert.equal((await one('SELECT tmdb_id FROM movies WHERE id=$1', [target.id])).tmdb_id, null);
  assert.equal(Number((await one('SELECT tmdb_id FROM movies WHERE id=$1', [holder.id])).tmdb_id), 400);
});

dbTest('three rows converge on one page one call at a time, and the second tv season stays separate', async () => {
  await reset();
  const a = await movie({ slug: 'a', media_type: 'series', title: 'Show (Phần 1)', created_at: '2024-01-01' });
  const b = await movie({ slug: 'b', media_type: 'series', title: 'Show (Phần 1) b', created_at: '2024-01-02', tmdb_season_number: 1 });
  const c = await movie({ slug: 'c-phan-1', media_type: 'series', title: 'Show c', created_at: '2024-01-03' });
  const s2 = await movie({ slug: 'show-phan-2', media_type: 'series', title: 'Show (Phần 2)', created_at: '2024-01-04' });
  await source(a.id, 'kkphim', 'a');
  await source(b.id, 'nguonc', 'b');
  await source(c.id, 'nguonc', 'c');
  await source(s2.id, 'kkphim', 's2');
  const input = { tmdbId: 500, mediaType: 'tv', numberOfSeasons: 2 };
  assert.equal((await identity.assignTmdbIdentity(a.id, input)).action, 'assigned');
  const second = await identity.assignTmdbIdentity(b.id, input);
  assert.equal(second.action, 'merged');
  const third = await identity.assignTmdbIdentity(c.id, input);
  assert.equal(third.action, 'merged');
  assert.equal(await count('SELECT count(*) n FROM movie_provider_sources WHERE movie_id=$1', [a.id]), 3);
  assert.equal((await identity.assignTmdbIdentity(s2.id, input)).action, 'assigned');
  assert.equal(await count('SELECT count(*) n FROM movies WHERE tmdb_id=500'), 2);
  assert.deepEqual((await pool.query('SELECT tmdb_season_number FROM movies WHERE tmdb_id=500 ORDER BY 1')).rows.map((r) => r.tmdb_season_number), [1, 2]);
});

dbTest('inferred identity is not folded into a row with a different imdb id', async () => {
  await reset();
  await movie({ slug: 'h', tmdb_id: 600, tmdb_media_type: 'movie', imdb_id: 'tt1', tmdb_id_source: 'provider' });
  const t = await movie({ slug: 't', imdb_id: 'tt2' });
  const result = await identity.assignTmdbIdentity(t.id, { tmdbId: 600, mediaType: 'movie' });
  assert.deepEqual([result.action, result.reason], ['blocked', 'imdb-differs']);
  assert.equal(await count('SELECT count(*) n FROM movies'), 2);
});

dbTest('a unique-index race returns conflict and leaves the data untouched', async () => {
  await reset();
  const t = await movie({ slug: 'race' });
  // Simulate a sync inserting the holder between the plan and the write: make the first plan
  // see no holder by hiding the row from it, then let the real index refuse the write.
  const realQuery = pool.connect.bind(pool);
  const holder = await movie({ slug: 'late', tmdb_id: 700, tmdb_media_type: 'movie' });
  const patched = new Map();
  pool.connect = async (...args) => {
    const result = realQuery(...args);
    if (args.length) return result; // pool.query() goes through the callback form
    const client = await result;
    if (!patched.has(client)) {
      const original = client.query;
      patched.set(client, original);
      const query = original.bind(client);
      client.query = (sql, ...rest) => (typeof sql === 'string' && sql.startsWith('SELECT * FROM movies WHERE tmdb_id=$1')
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : query(sql, ...rest));
    }
    return client;
  };
  try {
    const result = await identity.assignTmdbIdentity(t.id, { tmdbId: 700, mediaType: 'movie' });
    assert.equal(result.action, 'conflict');
    assert.match(result.reason, /^unique:movies_tmdb_movie_identity_idx/);
  } finally {
    pool.connect = realQuery;
    for (const [client, original] of patched) client.query = original;
  }
  assert.equal((await one('SELECT tmdb_id FROM movies WHERE id=$1', [t.id])).tmdb_id, null);
  assert.equal(await count('SELECT count(*) n FROM movies WHERE id=$1', [holder.id]), 1);
  assert.equal(await count("SELECT count(*) n FROM tmdb_identity_changes WHERE kind='conflict'"), 1);
});

dbTest('promoteVerifiedMatches applies a small batch, skips blocked titles on the next call', async () => {
  await reset();
  const ok = await movie({ slug: 'ok', tmdb_match_status: 'verified', tmdb_match_id: 800, tmdb_match_media_type: 'movie' });
  const bad = await movie({ slug: 'bad', media_type: 'series', title: 'Bad', tmdb_match_status: 'verified', tmdb_match_id: 801, tmdb_match_media_type: 'tv' });
  const dry = await identity.promoteVerifiedMatches({ mode: 'dry-run', seasonsFor: async () => 3 });
  assert.equal(dry.checked, 2);
  assert.equal(dry.planned.assign, 1);
  assert.equal(await count('SELECT count(*) n FROM tmdb_identity_changes'), 0);
  const stats = await identity.promoteVerifiedMatches({ mode: 'apply', limit: 10, seasonsFor: async () => 3 });
  assert.deepEqual([stats.assigned, stats.blocked, stats.reasons['season-unknown']], [1, 1, 1]);
  assert.deepEqual(stats.slugs, ['ok']);
  assert.equal(Number((await one('SELECT tmdb_id FROM movies WHERE id=$1', [ok.id])).tmdb_id), 800);
  assert.equal((await identity.listPromotionCandidates(10)).length, 0);
  assert.equal(bad.id.length > 0, true);
});
