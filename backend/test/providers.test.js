import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isControlledFuzzyMatch,
  mediaFamily,
  normalizeTitle
} from '../src/identity.js';
import { normalizeKkphim, normalizeNguonc } from '../src/normalize.js';
import { signedImageUrl } from '../src/images.js';
import { mergedMovie } from '../src/repository.js';
import { MovieProvider } from '../src/providers/MovieProvider.js';
import { NguoncProvider } from '../src/providers/NguoncProvider.js';
import { KkphimProvider } from '../src/providers/KkphimProvider.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name) {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
}

test('NguonC detail normalizes as the primary provider', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.equal(movie.provider, 'nguonc');
  assert.equal(movie.priority, 10);
  assert.equal(movie.mediaType, 'tv');
  assert.equal(movie.displayType, 'series');
  assert.equal(movie.genres[0].slug, 'chinh-kich');
  assert.equal(movie.countries[0].slug, 'trung-quoc');
  assert.equal(movie.streams[0].server_name, 'NguonC · Vietsub #1');
  assert.match(movie.streams[0].server_data[0].link_embed, /^https:/);
});

test('KKPhim detail preserves strong IDs and HLS fallback', () => {
  const payload = fixture('kkphim-detail.json');
  const movie = normalizeKkphim(payload);
  assert.equal(movie.provider, 'kkphim');
  assert.equal(movie.priority, 20);
  assert.equal(movie.tmdbId, 273119);
  assert.equal(movie.imdbId, 'tt31886947');
  assert.equal(movie.streams[0].server_name, 'KKPhim · Vietsub');
  assert.match(movie.streams[0].server_data[0].link_m3u8, /\.m3u8$/);
  assert.equal(movie.thumbSourceUrl, payload.movie.poster_url);
  assert.equal(movie.posterSourceUrl, payload.movie.thumb_url);
});

test('identity normalization is Unicode and punctuation stable', () => {
  assert.equal(normalizeTitle('  Trọng—Khí! '), 'trong khi');
  assert.equal(mediaFamily('hoathinh'), 'tv');
  assert.equal(
    isControlledFuzzyMatch(
      {
        title: 'Nhân Ngư',
        original_title: 'Ren Yu',
        year: 2026,
        media_type: 'tv'
      },
      {
        title: 'Nhan Ngu',
        originalTitle: 'Ren Yu',
        year: 2026,
        mediaType: 'tv'
      }
    ),
    true
  );
});

test('NguonC fields remain primary while KKPhim fills missing identifiers', () => {
  const primary = normalizeNguonc(fixture('nguonc-detail.json'));
  const fallback = normalizeKkphim(fixture('kkphim-detail.json'));
  const current = {
    title: primary.title,
    original_title: primary.originalTitle,
    normalized_title: primary.normalizedTitle,
    normalized_original_title: primary.normalizedOriginalTitle,
    media_type: primary.mediaType,
    display_type: primary.displayType,
    year: primary.year,
    tmdb_id: null,
    imdb_id: null,
    overview: primary.overview,
    thumb_source_url: primary.thumbSourceUrl,
    poster_source_url: primary.posterSourceUrl,
    quality: primary.quality,
    language: primary.language,
    status: primary.status,
    episode_current: primary.episodeCurrent,
    episode_total: primary.episodeTotal,
    duration: primary.duration,
    actors: primary.actors,
    directors: primary.directors,
    genres: primary.genres,
    countries: primary.countries,
    ratings: {},
    primary_provider: 'nguonc',
    provider_updated_at: primary.providerUpdatedAt
  };
  const merged = mergedMovie(current, fallback);
  assert.equal(merged.title, primary.title);
  assert.equal(merged.overview, primary.overview);
  assert.equal(merged.tmdbId, fallback.tmdbId);

  assert.equal(merged.imdbId, fallback.imdbId);
  assert.equal(merged.primaryProvider, 'nguonc');
});
test('KKPhim stream remains available when the primary stream is empty', () => {
  const primary = normalizeNguonc(fixture('nguonc-detail.json'));
  const fallback = normalizeKkphim(fixture('kkphim-detail.json'));
  primary.streams = [];
  const sources = [
    { provider: primary.provider, priority: primary.priority, streams: primary.streams },
    { provider: fallback.provider, priority: fallback.priority, streams: fallback.streams }
  ];
  const selected = sources.find((source) => source.streams.some(
    (server) => server.server_data.length > 0
  ));
  assert.equal(selected.provider, 'kkphim');
  assert.equal(primary.title, 'Trọng Khí');
});

test('provider list schema drift is not treated as an empty catalog', () => {
  const nguonc = new NguoncProvider();
  const kkphim = new KkphimProvider();
  assert.throws(() => nguonc.listItems({ unexpected: [] }), { name: 'ProviderSchemaError' });
  assert.throws(() => kkphim.listItems({ unexpected: [] }), { name: 'ProviderSchemaError' });
});

test('provider abstraction resolves normalized stream arrays', async () => {
  const provider = new MovieProvider('fixture', 99);
  provider.detail = async () => ({ normalized: { streams: [{ server_name: 'Fixture' }] } });
  const streams = await provider.resolveStreams('fixture');
  assert.deepEqual(streams, [{ server_name: 'Fixture' }]);
});

test('signed image URLs use the v2 canonical pipeline signature', () => {
  const url = new URL(signedImageUrl('https://phimimg.com/example.jpg', 'd'));
  assert.match(url.searchParams.get('sig'), /^v2\./);
  assert.match(url.pathname, /^\/i\/d\/[a-f0-9]{64}\.webp$/);
});
