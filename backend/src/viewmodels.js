import { createHash } from 'node:crypto';
import { config } from './config.js';

function imageUrl(assetId, variant) {
  return assetId ? config.publicBaseUrl + '/i/' + variant + '/' + assetId + '.webp' : '';
}
import {
  creditsForMovie,
  findMovie,
  findPersonBySlug,
  getHeroTrendingMovies,
  listCanonical,
  listReadyBySlugs,
  listPersonMovies,
  recommendationsForSlug,
  reviewsForMovie,
  findMovieIdBySlug,
  taxonomy,
  taxonomyName
} from './repository.js';
import { creditIdentity, normalizeCreditRole } from './people.js';
import { orderReviews, reviewCard } from './reviewOrder.js';

export const DETAIL_REVIEW_COUNT = 2;
const REVIEWS_MAX_LIMIT = 20;
const REVIEWS_DEFAULT_LIMIT = 10;

export function reviewsLimit(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return REVIEWS_DEFAULT_LIMIT;
  return Math.min(REVIEWS_MAX_LIMIT, parsed);
}

export function card(row) {
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
      vote_average: ratings.imdb || null,
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

function creditCard(row) {
  return {
    name: row.name,
    slug: row.slug,
    character: row.character_name || null,
    photo: imageUrl(row.profile_asset_id, 'm')
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

export const CARDS_MAX_SLUGS = 60;
const CARD_SLUG_MAX = 200;

// Returns { slugs } (deduplicated, request order) or { error }.
export function parseCardSlugs(raw) {
  const seen = new Set();
  const slugs = [];
  for (const part of String(raw || '').split(',')) {
    const slug = part.trim();
    if (!slug || slug.length > CARD_SLUG_MAX) continue;
    if (!seen.has(slug)) { seen.add(slug); slugs.push(slug); }
  }
  if (slugs.length > CARDS_MAX_SLUGS) return { error: 'too_many_slugs' };
  return { slugs };
}

// Depends only on the sorted slug set; hashed to keep the key short.
export function cardsCacheKey(slugs) {
  return 'cards:' + createHash('sha256').update([...slugs].sort().join(',')).digest('hex').slice(0, 32);
}

export async function buildCards(slugs) {
  const rows = await listReadyBySlugs(slugs);
  const bySlug = new Map(rows.map((row) => [row.canonical_slug, row]));
  return { items: slugs.filter((slug) => bySlug.has(slug)).map((slug) => card(bySlug.get(slug))) };
}

export async function buildList(type, page) {
  const result = await listCanonical({ type, page, limit: 24 });
  return listResponse(result, listTitle(type));
}

export async function buildGenre(slug, page) {
  const [result, name] = await Promise.all([
    listCanonical({ genre: slug, page, limit: 24 }),
    taxonomyName('genres', slug)
  ]);
  return listResponse(result, name);
}

export async function buildCountry(slug, page) {
  const [result, name] = await Promise.all([
    listCanonical({ country: slug, page, limit: 24 }),
    taxonomyName('countries', slug)
  ]);
  return listResponse(result, name);
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
  // Verified TMDB identities only, so most of the catalog has no rows here.
  // `actor`/`director` below stay in the payload for exactly that reason.
  const identity = creditIdentity(movie);
  const credits = identity
    ? await creditsForMovie(identity.mediaType, identity.tmdbId)
    : [];
  const reviews = orderReviews(await reviewsForMovie(movie.id), movie.canonical_slug);
  return {
    status: true,
    movie: {
      ...base,
      content: movie.overview,
      actor: movie.actors || [],
      director: movie.directors || [],
      people: {
        cast: credits.filter((row) => row.role === 'cast').map(creditCard),
        directors: credits.filter((row) => row.role === 'director').map(creditCard)
      },
      reviews: reviews.slice(0, DETAIL_REVIEW_COUNT).map(reviewCard),
      reviewCount: reviews.length,
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

/**
 * One page of TMDB reviews. Null means no such movie (404). Never calls TMDB;
 * the order depends only on the slug and the UTC day, so it is safe to cache
 * by slug+page+limit alone.
 */
export async function buildReviews(slug, page, limit) {
  const movieId = await findMovieIdBySlug(slug);
  if (!movieId) return null;
  const ordered = orderReviews(await reviewsForMovie(movieId), slug);
  const totalPages = Math.max(1, Math.ceil(ordered.length / limit));
  const start = (page - 1) * limit;
  return {
    reviews: ordered.slice(start, start + limit).map(reviewCard),
    reviewCount: ordered.length,
    page,
    limit,
    totalPages
  };
}

export async function buildRecommendations(slug) {
  return {
    items: (await recommendationsForSlug(slug)).map(card)
  };
}

/** Null means no such person; the route turns that into a 404. */
export async function buildPerson(slug, page, role) {
  const person = await findPersonBySlug(slug);
  if (!person) return null;
  const result = await listPersonMovies(person.id, {
    role: normalizeCreditRole(role),
    page
  });
  return {
    status: 'success',
    data: {
      titlePage: person.name,
      person: {
        name: person.name,
        slug: person.slug,
        photo: imageUrl(person.profile_asset_id, 'm')
      },
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

export async function buildTaxonomy(field) {
  return {
    status: 'success',
    data: {
      items: await taxonomy(field)
    }
  };
}
