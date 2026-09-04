import { config } from './config.js';

function imageUrl(assetId, variant) {
  return assetId ? config.publicBaseUrl + '/i/' + variant + '/' + assetId + '.webp' : '';
}
import {
  findMovie,
  getHeroTrendingMovies,
  listCanonical,
  recommendations,
  taxonomy
} from './repository.js';

// node-pg hands back `numeric` columns as strings to preserve precision, which
// would leak a "7.6" into a field every other producer fills with a number.
function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function card(row) {
function seasonTitle(row) {
  const season = row.tmdb_media_type === 'tv' ? row.tmdb_season_number : null;
  if (season === null || season === undefined) return String(row.title || '');
  const baseTitle = String(row.title || '').replace(/(?:\s+\(Phần\s+\d+\))+$/u, '');
  return baseTitle + ' (Phần ' + season + ')';
}
  const ratings = row.ratings || {};
  return {
    _id: row.id,
    name: seasonTitle(row),
    origin_name: row.original_title,
    slug: row.canonical_slug,
    type: row.display_type || row.media_type,
    year: row.year,
    thumb_url: imageUrl(row.tmdb_thumb_asset_id || row.thumb_asset_id || row.poster_asset_id, 'm'),
    poster_url: imageUrl(row.tmdb_poster_asset_id || row.poster_asset_id || row.thumb_asset_id, 'd'),
    quality: row.quality,
    lang: row.language,
    status: row.status,
    episode_current: row.episode_current,
    time: row.duration,
    category: row.genres || [],
    country: row.countries || [],
    tmdb: {
      id: row.tmdb_id,
      type: row.tmdb_media_type || row.media_type,
      season: row.tmdb_season_number ?? null,
      vote_average: ratings.tmdb || null,
      vote_count: ratings.tmdb_count || null
    },
    imdb: {
      id: row.imdb_id,
      // OMDb is a fallback, never an override. `lib/spotlight.ts` ranks the
      // home hero on this value, so preferring OMDb would quietly reshuffle the
      // front page for rows that already had a provider rating.
      vote_average: ratings.imdb || numeric(row.omdb_imdb_rating),
      vote_count: ratings.imdb_count || null
    },
    // Both visible Rotten Tomatoes badges come exclusively from MDBList.
    rotten: {
      tomatometer: row.mdblist_tomatoes ?? null,
      audience: row.mdblist_audience ?? null
    },
    modified: {
      time: row.catalog_sort_at || row.provider_updated_at || row.updated_at
    }
  };
}

function listTitle(type) {
  return {
    'phim-moi-cap-nhat': 'Phim mới cập nhật',
    'phim-le': 'Phim lẻ',
    'phim-bo': 'Phim bộ',
    'hoat-hinh': 'Hoạt hình',
    'tv-shows': 'TV Shows'
  }[type] || 'Danh sách phim';
}

function listResponse(result, title) {
  return {
    status: 'success',
    data: {
      titlePage: title,
      items: result.rows.map(card),
      params: {
        pagination: {
          totalItems: result.totalItems,
          totalItemsPerPage: result.limit,
          currentPage: result.page,
          totalPages: result.totalPages
        }
      }
    }
  };
}

export async function buildList(type, page) {
  const result = await listCanonical({ type, page, limit: 24 });
  return listResponse(result, listTitle(type));
}

export async function buildGenre(slug, page) {
  const result = await listCanonical({ genre: slug, page, limit: 24 });
  return listResponse(result, slug);
}

export async function buildCountry(slug, page) {
  const result = await listCanonical({ country: slug, page, limit: 24 });
  return listResponse(result, slug);
}

export async function buildSearch(keyword, page) {
  const result = await listCanonical({ keyword, page, limit: 24 });
  return listResponse(result, 'Tìm kiếm: ' + keyword);
}

export async function buildHome() {
  const [heroTrending, newMovies, phimLe, phimBo, hoatHinh] = await Promise.all([
    getHeroTrendingMovies(),
    listCanonical({ page: 1, limit: 24, includePlayable: true }),
    listCanonical({ type: 'phim-le', page: 1, limit: 24, includePlayable: true }),
    listCanonical({ type: 'phim-bo', page: 1, limit: 16 }),
    listCanonical({ type: 'hoat-hinh', page: 1, limit: 16 })
  ]);
  const fallbackHero = phimLe.rows
    .filter((movie) => movie.has_playable_source && movie.canonical_slug && (movie.poster_asset_id || movie.thumb_asset_id))
    .slice(0, config.heroTrendingLimit);
  return {
    // Hero cards carry the synopsis so the slider can render it without a
    // detail fetch; list/search cards stay lean.
    heroMovies: (heroTrending.length ? heroTrending : fallbackHero)
      .map((row) => ({ ...card(row), content: row.overview || null })),
    newMovies: { items: newMovies.rows.map(card) },
    phimLe: { items: phimLe.rows.slice(0, 16).map(card) },
    phimBo: { items: phimBo.rows.map(card) },
    hoatHinh: { items: hoatHinh.rows.map(card) }
  };
}

export async function buildMovie(slug) {
  const result = await findMovie(slug);
  if (!result) return null;
  const { movie, sources } = result;
  const base = card(movie);
  return {
    status: true,
    movie: {
      ...base,
      content: movie.overview,
      actor: movie.actors || [],
      director: movie.directors || [],
      episode_total: movie.episode_total,
      category: movie.genres || [],
      country: movie.countries || []
    },
    episodes: sources.flatMap((source) => (
      Array.isArray(source.streams) ? source.streams : []
    )),
    sources: sources.map((source) => ({
      provider: source.provider,
      priority: source.priority,
      availability: source.availability,
      provider_slug: source.provider_slug
    }))
  };
}

export async function buildRecommendations(mediaType, tmdbId) {
  return {
    items: (await recommendations(mediaType, tmdbId, 16)).map(card)
  };
}

export async function buildTaxonomy(field) {
  return {
    status: 'success',
    data: {
      items: await taxonomy(field)
    }
  };
}
