export function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (letter) => letter === 'đ' ? 'd' : 'D')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value) {
  return normalizeTitle(value).replace(/\s+/g, '-') || 'movie';
}

export function mediaFamily(value) {
  const type = String(value || '').toLowerCase();
  if (['single', 'movie', 'phim-le'].includes(type)) return 'movie';
  return 'tv';
}

function tokens(value) {
  return new Set(normalizeTitle(value).split(' ').filter(Boolean));
}

export function titleSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
}

export function isControlledFuzzyMatch(candidate, incoming, threshold = 0.96) {
  if (!candidate || !incoming) return false;
  if (candidate.year !== incoming.year) return false;
  if (mediaFamily(candidate.media_type) !== mediaFamily(incoming.mediaType)) return false;

  const originalScore = titleSimilarity(
    candidate.original_title,
    incoming.originalTitle
  );
  const titleScore = titleSimilarity(candidate.title, incoming.title);
  return Math.max(originalScore, titleScore) >= threshold;
}

// Trả về id nguồn nên dùng khi slug đã tồn tại dưới một provider_movie_id khác.
// Bản tóm tắt (fallback khi detail lỗi) không có id thật nên providerMovieId
// bị suy ra từ slug; giữ id cũ để không đụng UNIQUE (provider, provider_slug).
// Id thật khác id cũ nghĩa là provider cấp lại id cho cùng slug: đổi khóa hàng cũ.
export function reconcileSourceIdentity(incoming, existing) {
  if (!existing || existing.provider_movie_id === incoming.providerMovieId) {
    return { providerMovieId: incoming.providerMovieId, rekeyFrom: null };
  }
  if (incoming.providerMovieId === incoming.providerSlug) {
    return { providerMovieId: existing.provider_movie_id, rekeyFrom: null };
  }
  return { providerMovieId: incoming.providerMovieId, rekeyFrom: existing.provider_movie_id };
}

const SEASON_WORD = /(?:^| )(?:season|phan) (\d{1,2})(?: |$)/u;
const SEASON_SLUG = /(?:^|-)phan-(\d{1,2})(?:-(?:19|20)\d{2})?$/u;

function seasonInText(value) {
  const match = SEASON_WORD.exec(normalizeTitle(value));
  return match ? Number(match[1]) : null;
}

function seasonInSlug(value) {
  const match = SEASON_SLUG.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

// The season a provider record describes: KKPhim's TMDB season first, then a
// "(Phần N)" / "Season N" marker in either title, then a "-phan-N" slug.
export function incomingSeason(incoming) {
  if (incoming.tmdbMediaType === 'tv' && Number.isInteger(Number(incoming.tmdbSeasonNumber)) &&
    incoming.tmdbSeasonNumber !== null && incoming.tmdbSeasonNumber !== '') return Number(incoming.tmdbSeasonNumber);
  return seasonInText(incoming.title) ?? seasonInText(incoming.originalTitle) ?? seasonInSlug(incoming.providerSlug);
}

// The season a canonical row stands for, read the same way.
export function rowSeason(row) {
  if (row.tmdb_season_number !== null && row.tmdb_season_number !== undefined) return Number(row.tmdb_season_number);
  return seasonInText(row.title) ?? seasonInText(row.original_title) ?? seasonInSlug(row.canonical_slug);
}

// A series IMDb id (and a fuzzy title) is shared by every season, so a candidate row
// is only the same work when neither its season nor its TMDB tuple contradicts the
// incoming record. `identity` is the incoming TMDB tuple, or null.
export function identityConflict(row, incoming, identity) {
  if (!row) return null;
  if (mediaFamily(row.media_type) === 'tv' || mediaFamily(incoming.mediaType) === 'tv') {
    const have = rowSeason(row);
    const want = incomingSeason(incoming);
    if (have !== null && want !== null && have !== want) return 'season-differs';
  }
  if (identity && row.tmdb_id !== null && row.tmdb_id !== undefined) {
    if (Number(row.tmdb_id) !== identity.id || (row.tmdb_media_type && row.tmdb_media_type !== identity.mediaType)) return 'tmdb-differs';
    if (identity.mediaType === 'tv' && row.tmdb_season_number !== null && row.tmdb_season_number !== undefined &&
      Number(row.tmdb_season_number) !== identity.season) return 'season-differs';
  }
  return null;
}
