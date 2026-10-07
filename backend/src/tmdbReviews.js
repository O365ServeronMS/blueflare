import { createHash } from 'node:crypto';
import { config } from './config.js';
import { hasSpoilerWarning } from './reviewSpoiler.js';

export const REVIEW_MIN_CHARS = 40;
export const REVIEW_MAX_CHARS = 4000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Markdown/HTML review body to inert plain text.
 *
 * Entities are decoded first and tags stripped after, so `&lt;script&gt;` cannot
 * come back as markup. The output never contains `<tag>` sequences or control
 * characters; the frontend must still render it as text, never as HTML.
 */
export function toPlainText(input) {
  let text = String(input ?? '').replace(/\r\n?/g, '\n');
  // Two passes: the second catches tags that only appeared after decoding.
  for (let pass = 0; pass < 2; pass += 1) {
    text = decodeEntities(text)
      .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/<\s*br\s*\/?\s*>|<\/\s*(?:p|div|li|blockquote|h[1-6])\s*>/gi, '\n')
      .replace(/<\/?[a-z!][^>]*>?/gi, ' ');
  }
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  // A stray angle bracket left over from malformed markup is never useful text.
  return text.replace(/[<>]/g, '').trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/** Months between two instants, fractional, never negative. */
function monthsBetween(from, to) {
  return Math.max(0, (to - from) / (30.4375 * 24 * 60 * 60 * 1000));
}

/**
 * Score 0-100: rating*10 (neutral when unrated), body length up to a cap, and
 * a recency part that decays by a fixed factor per month. Weights come from
 * config.reviewScore; they are normalised, so they need not sum to 1.
 */
export function scoreReview(review, now = Date.now(), weights = config.reviewScore) {
  const rating = Number(review.rating);
  const ratingPart = review.rating === null || review.rating === undefined || !Number.isFinite(rating)
    ? weights.neutralRating
    : Math.min(100, Math.max(0, rating * 10));
  const lengthPart = Math.min(1, String(review.content || '').length / weights.lengthCap) * 100;
  const created = review.createdAt ? new Date(review.createdAt).getTime() : NaN;
  const recencyPart = Number.isFinite(created)
    ? 100 * Math.pow(weights.monthlyDecay, monthsBetween(created, now))
    : 0;
  const total = weights.ratingWeight + weights.lengthWeight + weights.recencyWeight;
  const score = (ratingPart * weights.ratingWeight + lengthPart * weights.lengthWeight + recencyPart * weights.recencyWeight) / total;
  return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /(^|\.)themoviedb\.org$/.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 10 ? Math.round(rating * 10) / 10 : null;
}

/**
 * Normalise raw TMDB /reviews results into stored rows, best first, capped.
 * A review id seen twice (page overlap) is kept once.
 */
export function parseTmdbReviews(results, options = {}) {
  const now = options.now ?? Date.now();
  const max = Math.max(1, Math.floor(options.maxPerMovie ?? config.tmdbReviewsMaxPerMovie));
  const seen = new Set();
  const reviews = [];
  for (const entry of Array.isArray(results) ? results : []) {
    const tmdbReviewId = String(entry?.id || '').trim().slice(0, 64);
    if (!tmdbReviewId || seen.has(tmdbReviewId)) continue;
    const content = toPlainText(entry?.content);
    if (content.length < REVIEW_MIN_CHARS) continue;
    seen.add(tmdbReviewId);
    const createdMs = entry?.created_at ? new Date(entry.created_at).getTime() : NaN;
    const review = {
      tmdbReviewId,
      author: toPlainText(entry?.author).slice(0, 120),
      authorUsername: toPlainText(entry?.author_details?.username).slice(0, 120) || null,
      rating: parseRating(entry?.author_details?.rating),
      content: truncate(content, REVIEW_MAX_CHARS),
      createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
      url: safeUrl(entry?.url)
    };
    review.hasSpoiler = hasSpoilerWarning(content);
    review.score = scoreReview(review, now);
    review.contentHash = createHash('sha256')
      .update([review.author, review.rating, review.content, review.url, review.hasSpoiler].join('\u0000'))
      .digest('hex');
    reviews.push(review);
  }
  reviews.sort((a, b) => b.score - a.score || a.tmdbReviewId.localeCompare(b.tmdbReviewId));
  return reviews.slice(0, max);
}
