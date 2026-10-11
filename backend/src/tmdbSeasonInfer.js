/**
 * Which TMDB season a catalog page is, when TMDB lists several and the page carries no
 * "(Phần N)" marker. Pure: callers fetch `show` (TMDB GET /tv/{id}) themselves.
 *
 * Conservative on purpose: an answer needs a year and an episode count that agree with exactly
 * one season, and no explicit season number in the titles that says otherwise. Everything else
 * is a null season with a reason, so the caller can leave the row alone.
 */
import { nguoncSeason } from './duplicateMerge.js';

const MIN_EPISODES = 3;
const MAX_YEAR_GAP = 1;
const FIT_RATIO = 1.25;
const GAP_EPISODES = 5;
const GAP_FRACTION = 0.25;

// "Season 2", "Phần 2", "Mùa 2", "Quyển 2", "Volume 2", "Part 2", "2nd Season", slug "phan-2" / "season-2".
const MARKER_WORD = /(?:^|[^\p{L}])(?:ph[aầ]n|season|m[uù]a|quy[eể]n|volume|vol\.?|part)[\s.:_-]*(\d{1,2})(?!\d)/iu;
const MARKER_ORDINAL = /(?:^|[^\p{L}\d])(\d{1,2})(?:st|nd|rd|th)\s+season/iu;
const TRAILING_NUMBER = /\s(\d{1,2})$/u;

const no = (reason) => ({ season: null, reason });

function yearOf(date) {
  const year = Number(String(date ?? '').slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

function episodesOf(value) {
  const match = /\d+/.exec(String(value ?? ''));
  return match ? Number(match[0]) : 0;
}

/** Season numbers the row's own names announce; the first alias may end in a bare number ("Tên 2"). */
export function declaredSeasons(row) {
  const found = [];
  for (const raw of [row.title, row.original_title]) {
    const text = String(raw ?? '').normalize('NFC').trim();
    if (!text) continue;
    for (const re of [MARKER_WORD, MARKER_ORDINAL]) {
      const hit = re.exec(text);
      if (hit) found.push(Number(hit[1]));
    }
  }
  const first = String(row.title ?? '').normalize('NFC').split(/\s[/|]\s|[;,]/u)[0].trim();
  const trailing = TRAILING_NUMBER.exec(first);
  if (trailing) found.push(Number(trailing[1]));
  const slug = String(row.canonical_slug ?? '').replace(/-(?:19|20)\d{2}$/u, '');
  const fromSlug = /(?:^|-)(?:phan|season|mua|quyen|part|volume)-(\d{1,2})$/u.exec(slug);
  if (fromSlug) found.push(Number(fromSlug[1]));
  return found;
}

function episodeGap(have, want) {
  const diff = Math.abs(have - want);
  return diff > GAP_EPISODES && diff / Math.max(1, Math.min(have, want)) > GAP_FRACTION;
}

/**
 * @returns {{season: number, tmdbSeason: {episodes: number, air_date: string|null}} | {season: null, reason: string}}
 */
export function inferSeasonFromTmdb(row, show) {
  const year = Number(row?.year);
  if (!Number.isInteger(year) || year <= 0) return no('no-year');
  const total = episodesOf(row.episode_total);
  if (total < MIN_EPISODES) return no('too-few-episodes');
  if (nguoncSeason(row) !== null) return no('has-season-marker');

  const seasons = (Array.isArray(show?.seasons) ? show.seasons : [])
    .filter((s) => Number.isInteger(s?.season_number) && s.season_number > 0)
    .map((s) => ({ number: s.season_number, episodes: Number(s.episode_count) || 0, air_date: s.air_date ?? null, year: yearOf(s.air_date) }));
  if (!seasons.length) return no('no-seasons');

  const accept = (s) => {
    if (s.year !== null && Math.abs(s.year - year) > MAX_YEAR_GAP) return no('year-gap');
    if (s.episodes > 0 && episodeGap(s.episodes, total)) return no('episode-gap');
    const conflict = declaredSeasons(row).some((n) => n !== s.number);
    if (conflict) return no('marker-conflict');
    return { season: s.number, tmdbSeason: { episodes: s.episodes, air_date: s.air_date } };
  };

  if (seasons.length === 1) return accept(seasons[0]);

  const byYear = seasons.filter((s) => s.year !== null && Math.abs(s.year - year) <= MAX_YEAR_GAP);
  const fits = byYear.filter((s) => s.episodes > 0 && Math.max(s.episodes, total) / Math.min(s.episodes, total) <= FIT_RATIO);
  if (fits.length > 1) return no('ambiguous');
  if (fits.length === 0) {
    if (!byYear.length) return no('year-gap');
    if (byYear.every((s) => s.episodes > 0 && episodeGap(s.episodes, total))) return no('episode-gap');
    return no('no-season-fits');
  }
  return accept(fits[0]);
}
