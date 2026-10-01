import { pool } from './db.js';
import { mergedMovie } from './repository.js';
import { planDuplicateMerges } from './duplicateMerge.js';

const COLUMNS = 'm.id, m.canonical_slug, m.title, m.normalized_original_title, m.year, m.media_type, ' +
  'm.tmdb_season_number, m.tmdb_identity_status, m.episode_total, m.episode_current, m.actors, m.directors, ' +
  '(SELECT array_agg(provider_slug) FROM movie_provider_sources WHERE movie_id=m.id) AS source_slugs';
const candidateSql = (having) =>
  'SELECT ' + COLUMNS + ' FROM movies m JOIN movie_provider_sources s ON s.movie_id=m.id ' +
  "WHERE m.catalog_state='ready' GROUP BY m.id HAVING " + having;

export async function planCatalogMerges() {
  const nguonc = (await pool.query(candidateSql("bool_or(s.provider='nguonc') AND NOT bool_or(s.provider='kkphim')"))).rows;
  const kk = (await pool.query(candidateSql("bool_or(s.provider='kkphim') AND NOT bool_or(s.provider='nguonc')"))).rows;
  return planDuplicateMerges(nguonc, kk);
}

function incomingFromRow(row) {
  return {
    provider: 'nguonc',
    title: row.title,
    originalTitle: row.original_title,
    normalizedTitle: row.normalized_title,
    normalizedOriginalTitle: row.normalized_original_title,
    mediaType: row.media_type,
    displayType: row.display_type,
    year: row.year,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    overview: row.overview,
    thumbSourceUrl: row.thumb_source_url,
    posterSourceUrl: row.poster_source_url,
    quality: row.quality,
    language: row.language,
    status: row.status,
    episodeCurrent: row.episode_current,
    episodeTotal: row.episode_total,
    duration: row.duration,
    actors: row.actors,
    directors: row.directors,
    genres: row.genres,
    countries: row.countries,
    ratings: row.ratings,
    providerUpdatedAt: row.provider_updated_at
  };
}

/**
 * Fold the NguonC-only row `dropId` into the KKPhim-only row `keepId`.
 * With `renameTo` the survivor takes that slug and the old one becomes an alias.
 * Returns { merged:false, reason } when either row no longer looks as planned,
 * or { merged:true, keptSlug, droppedSlug } after one committed transaction.
 */
export async function mergeDuplicate(keepId, dropId, renameTo = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = (await client.query(
      'SELECT * FROM movies WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[keepId, dropId]]
    )).rows;
    const keep = locked.find((row) => row.id === keepId);
    const drop = locked.find((row) => row.id === dropId);
    if (!keep || !drop || keep.catalog_state !== 'ready' || drop.catalog_state !== 'ready') {
      await client.query('ROLLBACK');
      return { merged: false, reason: 'row-missing' };
    }
    const providers = async (id) => (await client.query(
      'SELECT array_agg(DISTINCT provider ORDER BY provider) AS p FROM movie_provider_sources WHERE movie_id=$1', [id]
    )).rows[0].p || [];
    const [keepProviders, dropProviders] = [await providers(keepId), await providers(dropId)];
    if (keepProviders.join() !== 'kkphim' || dropProviders.join() !== 'nguonc') {
      await client.query('ROLLBACK');
      return { merged: false, reason: 'providers-changed' };
    }

    const favorites = (await client.query('SELECT * FROM user_favorites WHERE movie_id=$1', [dropId])).rows;
    const history = (await client.query('SELECT * FROM user_history WHERE movie_id=$1', [dropId])).rows;
    const hero = (await client.query('SELECT * FROM hero_trending_entries WHERE movie_id=$1', [dropId])).rows;
    const sourceIds = (await client.query('SELECT id FROM movie_provider_sources WHERE movie_id=$1', [dropId])).rows.map((r) => r.id);

    await client.query(
      'INSERT INTO movie_merges (kept_movie_id, kept_slug, dropped_movie_id, dropped_slug, dropped_row, ' +
      'kept_row_before, moved_source_ids, favorites, history, hero) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [keepId, keep.canonical_slug, dropId, drop.canonical_slug, JSON.stringify(drop), JSON.stringify(keep),
        sourceIds, JSON.stringify(favorites), JSON.stringify(history), JSON.stringify(hero)]
    );

    await client.query('UPDATE movie_provider_sources SET movie_id=$1, updated_at=now() WHERE movie_id=$2', [keepId, dropId]);

    const merged = mergedMovie(keep, incomingFromRow(drop));
    const thumbAsset = merged.thumbSourceUrl === drop.thumb_source_url ? drop.thumb_asset_id : keep.thumb_asset_id;
    const posterAsset = merged.posterSourceUrl === drop.poster_source_url ? drop.poster_asset_id : keep.poster_asset_id;
    await client.query(
      'UPDATE movies SET title=$2, original_title=$3, normalized_title=$4, normalized_original_title=$5, ' +
      'media_type=$6, display_type=$7, year=$8, tmdb_id=$9, imdb_id=$10, overview=$11, thumb_source_url=$12, ' +
      'poster_source_url=$13, quality=$14, language=$15, status=$16, episode_current=$17, episode_total=$18, ' +
      'duration=$19, actors=$20, directors=$21, genres=$22, countries=$23, ratings=$24, primary_provider=$25, ' +
      'provider_updated_at=$26, thumb_asset_id=$27, poster_asset_id=$28, ' +
      'catalog_sort_at=COALESCE($26, catalog_sort_at), updated_at=now() WHERE id=$1',
      [keepId, merged.title, merged.originalTitle, merged.normalizedTitle, merged.normalizedOriginalTitle,
        merged.mediaType, merged.displayType, merged.year, merged.tmdbId, merged.imdbId, merged.overview,
        merged.thumbSourceUrl, merged.posterSourceUrl, merged.quality, merged.language, merged.status,
        merged.episodeCurrent, merged.episodeTotal, merged.duration, JSON.stringify(merged.actors),
        JSON.stringify(merged.directors), JSON.stringify(merged.genres), JSON.stringify(merged.countries),
        JSON.stringify(merged.ratings), merged.primaryProvider, merged.providerUpdatedAt, thumbAsset, posterAsset]
    );

    await client.query(
      'INSERT INTO user_favorites (user_id, movie_id, created_at) ' +
      'SELECT user_id, $1, created_at FROM user_favorites WHERE movie_id=$2 ON CONFLICT DO NOTHING', [keepId, dropId]
    );
    await client.query(
      'INSERT INTO user_history (user_id, movie_id, watched_at, server_name, episode_key, episode_name) ' +
      'SELECT user_id, $1, watched_at, server_name, episode_key, episode_name FROM user_history WHERE movie_id=$2 ' +
      'ON CONFLICT (user_id, movie_id) DO UPDATE SET watched_at=EXCLUDED.watched_at, server_name=EXCLUDED.server_name, ' +
      'episode_key=EXCLUDED.episode_key, episode_name=EXCLUDED.episode_name WHERE EXCLUDED.watched_at > user_history.watched_at',
      [keepId, dropId]
    );
    await client.query(
      'UPDATE hero_trending_entries SET movie_id=$1 WHERE movie_id=$2 ' +
      'AND NOT EXISTS (SELECT 1 FROM hero_trending_entries WHERE movie_id=$1)', [keepId, dropId]
    );

    await client.query('UPDATE movie_slug_aliases SET movie_id=$1 WHERE movie_id=$2', [keepId, dropId]);
    await client.query('DELETE FROM movies WHERE id=$1', [dropId]);
    await client.query(
      'INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2) ' +
      'ON CONFLICT (slug) DO UPDATE SET movie_id=EXCLUDED.movie_id', [drop.canonical_slug, keepId]
    );
    let keptSlug = keep.canonical_slug;
    if (renameTo && renameTo !== keptSlug) {
      await client.query('DELETE FROM movie_slug_aliases WHERE slug=$1', [renameTo]);
      await client.query('UPDATE movies SET canonical_slug=$2 WHERE id=$1', [keepId, renameTo]);
      await client.query(
        'INSERT INTO movie_slug_aliases (slug, movie_id) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET movie_id=EXCLUDED.movie_id',
        [keptSlug, keepId]
      );
      keptSlug = renameTo;
    }
    await client.query('COMMIT');
    return { merged: true, keptSlug, droppedSlug: drop.canonical_slug, previousSlug: keep.canonical_slug };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
