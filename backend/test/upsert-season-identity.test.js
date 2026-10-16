import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { upsertCanonical } from '../src/repository.js';
import { identityConflict, incomingSeason, rowSeason } from '../src/identity.js';

// Production state 2026-10-15 for The Diplomat (TMDB tv 203857, IMDb tt17491088, an id
// every season shares): one canonical row per season 1-3, each holding the series imdb id.
// KKPhim then published `nha-ngoai-giao-phan-4` (tmdb 203857 / season 4). The imdb lookup
// picked the season 2 row and the provider path rewrote its season to 4.
const diplomatRow = (id, season, year, slug) => ({
  id, canonical_slug: slug, title: `Nhà Ngoại Giao (Phần ${season})`,
  original_title: `The Diplomat (Season ${season})`, normalized_title: `nha ngoai giao phan ${season}`,
  normalized_original_title: `the diplomat season ${season}`, media_type: 'tv', display_type: 'series', year,
  tmdb_id: 203857, tmdb_media_type: 'tv', tmdb_season_number: season, imdb_id: 'tt17491088',
  catalog_state: 'ready', primary_provider: 'nguonc', actors: [], directors: [], genres: [], countries: [],
  ratings: {}, created_at: `2026-08-2${season}T00:00:00Z`
});

function fakeDatabase(movies, { sourceRow = null } = {}) {
  const sources = [];
  const statements = [];
  const reply = (rows) => ({ rows, rowCount: rows.length });
  const client = {
    release() {},
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return reply([]);
      if (sql.startsWith('SELECT provider_movie_id FROM movie_provider_sources')) return reply([]);
      if (sql.includes('JOIN movie_provider_sources s ON s.movie_id = m.id')) return reply(movies.filter((m) => m.id === sourceRow));
      if (sql.includes('WHERE tmdb_id=$1 AND tmdb_media_type=$2')) {
        return reply(movies.filter((m) => m.tmdb_id === params[0] && m.tmdb_media_type === params[1] &&
          (m.tmdb_season_number ?? null) === (params[2] ?? null)));
      }
      if (sql.includes('WHERE imdb_id = $1 AND media_type = $2')) {
        // Worst case for the old LIMIT 1: the season 2 row comes first.
        return reply(movies.filter((m) => m.imdb_id === params[0] && m.media_type === params[1])
          .sort((a, b) => (a.tmdb_season_number === 2 ? -1 : b.tmdb_season_number === 2 ? 1 : 0)));
      }
      if (sql.startsWith('SELECT 1 FROM movies WHERE canonical_slug')) {
        return reply(movies.filter((m) => m.canonical_slug === params[0]).map(() => ({ 1: 1 })));
      }
      if (sql.startsWith('INSERT INTO image_assets')) return reply([{ id: 'asset-1' }]);
      if (sql.startsWith('INSERT INTO movies')) {
        const [slug, title, originalTitle, , , mediaType, , year, tmdbId, imdbId] = params;
        const row = { id: 'new-row', canonical_slug: slug, title, original_title: originalTitle, media_type: mediaType,
          year, tmdb_id: tmdbId, tmdb_media_type: null, tmdb_season_number: null, imdb_id: imdbId };
        movies.push(row);
        return reply([row]);
      }
      if (sql.startsWith('UPDATE movies SET tmdb_id=$2, tmdb_media_type=$3, tmdb_season_number=$4')) {
        const row = movies.find((m) => m.id === params[0]);
        Object.assign(row, { tmdb_id: params[1], tmdb_media_type: params[2], tmdb_season_number: params[3] });
        return reply([row]);
      }
      if (sql.startsWith('UPDATE movies SET')) return reply(movies.filter((m) => m.id === params[0]));
      if (sql.startsWith('INSERT INTO movie_provider_sources')) {
        sources.push({ movie_id: params[0], provider: params[1], provider_slug: params[3] });
        return reply([]);
      }
      return reply([]);
    }
  };
  return { client, statements, sources };
}

async function withFakePool(client, run) {
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  try {
    return await run();
  } finally {
    pool.connect = originalConnect;
  }
}

const season4 = {
  provider: 'kkphim', providerMovieId: 'kk-diplomat-4', providerSlug: 'nha-ngoai-giao-phan-4', priority: 20,
  title: 'Nhà Ngoại Giao (Phần 4)', originalTitle: 'The Diplomat (Season 4)', normalizedTitle: 'nha ngoai giao phan 4',
  normalizedOriginalTitle: 'the diplomat season 4', mediaType: 'tv', displayType: 'series', year: 2026,
  tmdbId: 203857, tmdbMediaType: 'tv', tmdbSeasonNumber: 4, imdbId: 'tt17491088',
  overview: null, thumbSourceUrl: null, posterSourceUrl: null, quality: null, language: null, status: null,
  episodeCurrent: null, episodeTotal: '8', duration: null, actors: [], directors: [], genres: [], countries: [],
  ratings: {}, metadata: {}, streams: [], providerUpdatedAt: null
};

test('a new KKPhim season sharing the series imdb id gets its own row instead of rewriting another season', async () => {
  const movies = [
    diplomatRow('s1', 1, 2023, 'nha-ngoai-giao-phan-1'),
    diplomatRow('s2', 2, 2024, 'nha-ngoai-giao-phan-2-2024'),
    diplomatRow('s3', 3, 2025, 'nha-ngoai-giao-phan-3-2')
  ];
  const { client, statements, sources } = fakeDatabase(movies);
  const { movie } = await withFakePool(client, () => upsertCanonical(season4));

  assert.equal(movie.id, 'new-row');
  assert.equal(movie.tmdb_season_number, 4);
  assert.deepEqual(movies.filter((m) => m.id !== 'new-row').map((m) => m.tmdb_season_number), [1, 2, 3]);
  assert.deepEqual(sources, [{ movie_id: 'new-row', provider: 'kkphim', provider_slug: 'nha-ngoai-giao-phan-4' }]);
  assert.equal(statements.some((s) => s.sql.startsWith('INSERT INTO tmdb_identity_changes')), false);
});

test('the imdb lookup still attaches a record to the season row it belongs to', async () => {
  const movies = [diplomatRow('s2', 2, 2024, 'nha-ngoai-giao-phan-2-2024'), { ...diplomatRow('s4', 4, 2026, 'nha-ngoai-giao-phan-4'), tmdb_id: null, tmdb_media_type: null, tmdb_season_number: null }];
  const { client, sources } = fakeDatabase(movies);
  const { movie } = await withFakePool(client, () => upsertCanonical(season4));
  assert.equal(movie.id, 's4');
  assert.equal(sources[0].movie_id, 's4');
});

test('relocate ignores the row a record sits on and picks its row afresh (catalog audit move_source)', async () => {
  // A NguonC season 4 record (no TMDB id to contradict anything) sits on the season 2 row.
  const nguonc4 = { ...season4, provider: 'nguonc', providerMovieId: 'nc-diplomat-4', priority: 10, tmdbId: null, tmdbMediaType: null, tmdbSeasonNumber: null, imdbId: null };
  const fresh = () => [diplomatRow('s2', 2, 2024, 'nha-ngoai-giao-phan-2-2024')];
  const stays = fakeDatabase(fresh(), { sourceRow: 's2' });
  assert.equal((await withFakePool(stays.client, () => upsertCanonical(nguonc4))).movie.id, 's2');
  const moves = fakeDatabase(fresh(), { sourceRow: 's2' });
  const { movie } = await withFakePool(moves.client, () => upsertCanonical(nguonc4, { relocate: true }));
  assert.notEqual(movie.id, 's2');
  assert.equal(moves.statements.some((st) => st.sql.includes('JOIN movie_provider_sources s ON s.movie_id = m.id')), false);
  assert.equal(moves.sources[0].movie_id, movie.id);
});

test('incomingSeason and rowSeason read TMDB season, title markers and slugs', () => {
  assert.equal(incomingSeason(season4), 4);
  assert.equal(incomingSeason({ title: 'Tháp Thần Linh', originalTitle: 'Tower of God Season 2', providerSlug: 'x' }), 2);
  assert.equal(incomingSeason({ title: 'Một Nửa Ranma', originalTitle: null, providerSlug: 'mot-nua-ranma-phan-3-2026' }), 3);
  assert.equal(incomingSeason({ title: 'Mùa Hè', originalTitle: 'Summer', providerSlug: 'mua-he' }), null);
  assert.equal(rowSeason({ tmdb_season_number: 3, title: 'X (Phần 4)' }), 3);
  assert.equal(rowSeason({ tmdb_season_number: null, title: 'Nhà Ngoại Giao (Phần 2)' }), 2);
});

test('identityConflict rejects another season or another TMDB title, accepts unknowns', () => {
  const identity = { id: 203857, mediaType: 'tv', season: 4 };
  assert.equal(identityConflict(diplomatRow('s2', 2, 2024, 'x'), season4, identity), 'season-differs');
  assert.equal(identityConflict({ ...diplomatRow('s4', 4, 2026, 'x'), tmdb_id: 1 }, season4, identity), 'tmdb-differs');
  assert.equal(identityConflict(diplomatRow('s4', 4, 2026, 'x'), season4, identity), null);
  assert.equal(identityConflict({ media_type: 'tv', title: 'Nhà Ngoại Giao', canonical_slug: 'nha-ngoai-giao' }, season4, identity), null);
  assert.equal(identityConflict({ media_type: 'movie', tmdb_id: 5, tmdb_media_type: 'movie' }, { mediaType: 'movie' }, null), null);
});
