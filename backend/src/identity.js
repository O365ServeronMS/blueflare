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
