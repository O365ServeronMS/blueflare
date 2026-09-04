/**
 * One-shot OMDb coverage probe.
 *
 * Answers the only question that decides whether the Rotten Tomatoes badge is
 * worth building: on *this* catalog, how many of the rows a visitor actually
 * sees does OMDb return a Tomatometer for?
 *
 * It samples the exact rows the demand-driven job would pick — the home hero
 * plus page 1 of each configured list — resolves a missing imdb_id through
 * TMDB `/external_ids` the way the real job would, then calls OMDb once per
 * row and reports the hit rate per bucket.
 *
 * Writes nothing. Run it inside a container that can reach `api` and postgres:
 *   docker cp backend/scripts/omdb-probe.mjs blueflare-worker:/tmp/
 *   docker exec -e OMDB_API_KEY=... blueflare-worker node /tmp/omdb-probe.mjs
 */
import pg from 'pg';

const OMDB_KEY = process.env.OMDB_API_KEY || '';
const OMDB_BASE = (process.env.OMDB_BASE_URL || 'https://www.omdbapi.com').replace(/\/$/, '');
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/$/, '');
const API = (process.env.IMAGE_ORIGIN_URL || 'http://api:3200').replace(/\/$/, '');

if (!OMDB_KEY) throw new Error('OMDB_API_KEY is required');

// Sample size per bucket. Total is the OMDb request budget this run spends.
const SAMPLE = {
  trending: 20,
  'phim-le': 20,
  'phim-bo': 10,
  'hoat-hinh': 5,
  'tv-shows': 5
};

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(url + ' -> HTTP ' + response.status);
  return response.json();
}

function slugsOf(items) {
  return (Array.isArray(items) ? items : []).map((item) => item?.slug).filter(Boolean);
}

/** The same visible set `collectRatingTargets()` would build. */
async function collectBuckets() {
  const home = await getJson(API + '/api/home-data');
  const buckets = { trending: slugsOf(home?.heroMovies) };
  for (const type of ['phim-le', 'phim-bo', 'hoat-hinh', 'tv-shows']) {
    const list = await getJson(API + '/api/list?type=' + type + '&page=1');
    buckets[type] = slugsOf(list?.data?.items);
  }
  return buckets;
}

async function loadRows(client, slugs) {
  const { rows } = await client.query(
    'SELECT canonical_slug, title, original_title, year, media_type, ' +
    'imdb_id, tmdb_id, tmdb_media_type, ratings FROM movies WHERE canonical_slug = ANY($1)',
    [slugs]
  );
  return new Map(rows.map((row) => [row.canonical_slug, row]));
}

/** Free of OMDb quota: this is what lifts the 20% imdb_id coverage. */
async function resolveImdbId(row) {
  if (!TMDB_KEY || !row.tmdb_id) return null;
  const kind = row.tmdb_media_type === 'tv' || row.media_type === 'tv' ? 'tv' : 'movie';
  try {
    const body = await getJson(
      TMDB_BASE + '/' + kind + '/' + row.tmdb_id + '/external_ids?api_key=' + TMDB_KEY
    );
    const id = String(body?.imdb_id || '').trim();
    return /^tt\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function parseRatings(body) {
  const find = (source) => (Array.isArray(body?.Ratings) ? body.Ratings : [])
    .find((entry) => entry?.Source === source)?.Value;
  const tomato = String(find('Rotten Tomatoes') || '').match(/^(\d{1,3})%$/);
  const meta = String(find('Metacritic') || '').match(/^(\d{1,3})\/100$/);
  const imdb = Number(body?.imdbRating);
  return {
    tomatometer: tomato ? Number(tomato[1]) : null,
    metascore: meta ? Number(meta[1]) : null,
    imdbRating: Number.isFinite(imdb) && imdb > 0 ? imdb : null
  };
}

async function fetchOmdb(imdbId) {
  const url = OMDB_BASE + '/?i=' + encodeURIComponent(imdbId) + '&apikey=' + OMDB_KEY;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return { status: 'error', detail: 'HTTP ' + response.status };
  const body = await response.json();
  if (body?.Response !== 'True') return { status: 'unmatched', detail: body?.Error || 'unknown' };
  return { status: 'matched', ...parseRatings(body) };
}

function pct(part, whole) {
  return whole ? (Math.round((part / whole) * 1000) / 10).toFixed(1) + '%' : '-';
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const buckets = await collectBuckets();
  const report = [];
  let spent = 0;

  for (const [bucket, slugs] of Object.entries(buckets)) {
    const sample = slugs.slice(0, SAMPLE[bucket] ?? 0);
    const rows = await loadRows(client, sample);
    const stat = {
      bucket,
      visible: slugs.length,
      sampled: sample.length,
      hadImdbId: 0,
      liftedByTmdb: 0,
      noId: 0,
      omdbMatched: 0,
      omdbUnmatched: 0,
      omdbError: 0,
      tomato: 0,
      metascore: 0,
      imdbRating: 0
    };

    for (const slug of sample) {
      const row = rows.get(slug);
      if (!row) continue;
      let imdbId = row.imdb_id;
      if (imdbId) stat.hadImdbId += 1;
      else {
        imdbId = await resolveImdbId(row);
        if (imdbId) stat.liftedByTmdb += 1;
      }
      if (!imdbId) {
        stat.noId += 1;
        continue;
      }

      const result = await fetchOmdb(imdbId);
      spent += 1;
      if (result.status === 'error') {
        stat.omdbError += 1;
        console.warn('  ! ' + slug + ' ' + result.detail);
        continue;
      }
      if (result.status === 'unmatched') {
        stat.omdbUnmatched += 1;
        continue;
      }
      stat.omdbMatched += 1;
      if (result.tomatometer !== null) stat.tomato += 1;
      if (result.metascore !== null) stat.metascore += 1;
      if (result.imdbRating !== null) stat.imdbRating += 1;
      console.log(
        '  ' + (result.tomatometer !== null ? 'RT ' + String(result.tomatometer).padStart(3) : 'RT  --') +
        '  MC ' + String(result.metascore ?? '--').padStart(3) +
        '  IMDb ' + String(result.imdbRating ?? '--').padStart(4) +
        '  ' + (row.original_title || row.title)
      );
    }
    report.push(stat);
    console.log('--- ' + bucket + ' done ---');
  }

  await client.end();

  console.log('\n=== OMDb coverage probe ===');
  console.log(
    ['bucket', 'sampled', 'has_id', 'tmdb_lift', 'no_id', 'omdb_ok', 'RT', 'RT%_of_sampled', 'MC', 'IMDb']
      .join('\t')
  );
  const total = { sampled: 0, hadImdbId: 0, liftedByTmdb: 0, noId: 0, omdbMatched: 0, tomato: 0, metascore: 0, imdbRating: 0 };
  for (const stat of report) {
    for (const key of Object.keys(total)) total[key] += stat[key];
    console.log([
      stat.bucket, stat.sampled, stat.hadImdbId, stat.liftedByTmdb, stat.noId,
      stat.omdbMatched, stat.tomato, pct(stat.tomato, stat.sampled), stat.metascore, stat.imdbRating
    ].join('\t'));
  }
  console.log([
    'TOTAL', total.sampled, total.hadImdbId, total.liftedByTmdb, total.noId,
    total.omdbMatched, total.tomato, pct(total.tomato, total.sampled), total.metascore, total.imdbRating
  ].join('\t'));
  console.log('\nOMDb requests spent: ' + spent);
  console.log('imdb_id coverage after TMDB lift: ' +
    pct(total.hadImdbId + total.liftedByTmdb, total.sampled));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
