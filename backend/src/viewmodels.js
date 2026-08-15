import { config } from './config.js';

function imageUrl(assetId, variant) {
  return assetId ? config.publicBaseUrl + '/i/' + variant + '/' + assetId + '.webp' : '';
}
import {
  findMovie,
  listCanonical,
  recommendations,
  taxonomy
} from './repository.js';

function card(row) {
  const ratings = row.ratings || {};
  return {
    _id: row.id,
    name: row.title,
    origin_name: row.original_title,
    slug: row.canonical_slug,
    type: row.display_type || row.media_type,
    year: row.year,
    thumb_url: imageUrl(row.thumb_asset_id || row.poster_asset_id, 'm'),
    poster_url: imageUrl(row.poster_asset_id || row.thumb_asset_id, 'd'),
    quality: row.quality,
    lang: row.language,
    status: row.status,
    episode_current: row.episode_current,
    time: row.duration,
    category: row.genres || [],
    country: row.countries || [],
    tmdb: {
      id: row.tmdb_id,
      type: row.media_type,
      vote_average: ratings.tmdb || null,
      vote_count: ratings.tmdb_count || null
    },
    imdb: {
      id: row.imdb_id,
      vote_average: ratings.imdb || null,
      vote_count: ratings.imdb_count || null
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
  const [newMovies, phimLe, phimBo, hoatHinh] = await Promise.all([
    listCanonical({ page: 1, limit: 24, includePlayable: true }),
    listCanonical({ type: 'phim-le', page: 1, limit: 16 }),
    listCanonical({ type: 'phim-bo', page: 1, limit: 16 }),
    listCanonical({ type: 'hoat-hinh', page: 1, limit: 16 })
  ]);
  const newCards = newMovies.rows.map(card);
  const heroMovies = newMovies.rows
    .filter((movie) => (
      movie.has_playable_source &&
      movie.poster_source_url &&
      String(movie.overview || '').trim().length >= 60
    ))
    .slice(0, 5)
    .map(card);
  return {
    heroMovies,
    newMovies: { items: newCards },
    phimLe: { items: phimLe.rows.map(card) },
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
