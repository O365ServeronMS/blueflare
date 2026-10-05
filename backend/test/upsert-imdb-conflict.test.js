import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { upsertCanonical } from '../src/repository.js';

// Production state 2026-10-05 for tt9100018: canonical row `coi-nguon-toi-ac` is verified
// as TMDB 901121 ("Cú Máy Ăn Tiền") and holds imdb tt9100018. The KKPhim source
// `coi-nguon-toi-ac` (stored tmdb_id 709631, "Cội Nguồn Tội Ác") is still attached to it.
// Its KKPhim detail returns tmdb 709631 + imdb tt9100018.
function fakeDatabase() {
  const movies = [{
    id: 'bc4d28d5-2796-44ac-9363-ab8ffaf851aa', canonical_slug: 'coi-nguon-toi-ac',
    title: 'Cú Máy Ăn Tiền', original_title: null, normalized_title: 'cu may an tien',
    normalized_original_title: null, media_type: 'movie', display_type: 'single', year: 2023,
    tmdb_id: 901121, tmdb_media_type: 'movie', tmdb_season_number: null, imdb_id: 'tt9100018',
    catalog_state: 'ready', primary_provider: 'nguonc', actors: [], directors: [], genres: [],
    countries: [], ratings: {}
  }];
  const sources = [{
    movie_id: movies[0].id, provider: 'kkphim', provider_movie_id: '6a53717d46743ebe6e083a24',
    provider_slug: 'coi-nguon-toi-ac'
  }];
  const statements = [];
  const reply = (rows) => ({ rows, rowCount: rows.length });
  const client = {
    release() {},
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return reply([]);
      if (sql.startsWith('SELECT provider_movie_id FROM movie_provider_sources')) {
        return reply(sources.filter((s) => s.provider === params[0] && s.provider_slug === params[1]));
      }
      if (sql.includes('JOIN movie_provider_sources s ON s.movie_id = m.id')) {
        const ids = sources.filter((s) => s.provider === params[0] &&
          (s.provider_movie_id === params[1] || s.provider_slug === params[2])).map((s) => s.movie_id);
        return reply(movies.filter((m) => ids.includes(m.id)).slice(0, 1));
      }
      if (sql.includes('WHERE tmdb_id=$1 AND tmdb_media_type=$2')) {
        return reply(movies.filter((m) => m.tmdb_id === params[0] && m.tmdb_media_type === params[1]));
      }
      if (sql.includes('WHERE imdb_id = $1 AND media_type = $2')) {
        return reply(movies.filter((m) => m.imdb_id === params[0] && m.media_type === params[1]));
      }
      if (sql.startsWith('SELECT 1 FROM movies WHERE canonical_slug')) {
        return reply(movies.filter((m) => m.canonical_slug === params[0]).map(() => ({ 1: 1 })));
      }
      if (sql.startsWith('INSERT INTO image_assets')) return reply([{ id: 'asset-1' }]);
      if (sql.startsWith('INSERT INTO movies')) {
        const [slug, , , , , mediaType, , , tmdbId, imdbId] = params;
        // movies_imdb_identity_idx: UNIQUE (imdb_id, media_type) WHERE imdb_id IS NOT NULL AND tmdb_season_number IS NULL
        if (imdbId && movies.some((m) => m.imdb_id === imdbId && m.media_type === mediaType && m.tmdb_season_number == null)) {
          const error = new Error('duplicate key value violates unique constraint "movies_imdb_identity_idx"');
          error.code = '23505';
          throw error;
        }
        const row = { ...movies[0], id: 'new-row', canonical_slug: slug, tmdb_id: tmdbId, imdb_id: imdbId };
        movies.push(row);
        return reply([row]);
      }
      if (sql.startsWith('UPDATE movies SET')) {
        const row = movies.find((m) => m.id === params[0]);
        return reply(row ? [row] : []);
      }
      return reply([]);
    }
  };
  return { client, statements };
}

test('stale KKPhim refresh whose imdb id belongs to another canonical row does not hit movies_imdb_identity_idx', async () => {
  const { client, statements } = fakeDatabase();
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  try {
    const incoming = {
      provider: 'kkphim', providerMovieId: '6a53717d46743ebe6e083a24', providerSlug: 'coi-nguon-toi-ac',
      priority: 20, title: 'Cội Nguồn Tội Ác', originalTitle: null, normalizedTitle: 'coi nguon toi ac',
      normalizedOriginalTitle: null, mediaType: 'movie', displayType: 'single', year: 2023,
      tmdbId: 709631, tmdbMediaType: 'movie', tmdbSeasonNumber: null, imdbId: 'tt9100018',
      overview: null, thumbSourceUrl: null, posterSourceUrl: null, quality: null, language: null,
      status: null, episodeCurrent: null, episodeTotal: null, duration: null, actors: [], directors: [],
      genres: [], countries: [], ratings: {}, metadata: {}, streams: [], providerUpdatedAt: null
    };
    await assert.doesNotReject(() => upsertCanonical(incoming));
    const inserts = statements.filter((s) => s.sql.startsWith('INSERT INTO movies'));
    assert.deepEqual(inserts.map((s) => s.params[9]).filter((imdb) => imdb === 'tt9100018'), [],
      'must not INSERT a second movies row with an imdb id another row already holds');
  } finally {
    pool.connect = originalConnect;
  }
});
