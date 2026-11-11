import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeNguonc, normalizeKkphim } from '../src/normalize.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
function fixture(name) {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
}

// --- NguonC normalization ---

test('NguonC: categorizes "Phim bộ" format as series', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.equal(movie.displayType, 'series');
  assert.equal(movie.mediaType, 'tv');
});

test('NguonC: extracts genres from category groups', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.ok(movie.genres.length > 0);
  assert.equal(movie.genres[0].slug, 'chinh-kich');
  assert.equal(movie.genres[0].name, 'Chính Kịch');
});

test('NguonC: extracts countries from category groups', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.ok(movie.countries.length > 0);
  assert.equal(movie.countries[0].slug, 'trung-quoc');
});

test('NguonC: extracts year from top-level field', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.equal(movie.year, 2026);
});

test('NguonC: extracts year from category group when top-level missing', () => {
  const payload = fixture('nguonc-detail.json');
  delete payload.movie.year;
  const movie = normalizeNguonc(payload);
  assert.equal(movie.year, 2026);
});

test('NguonC: normalizes stream server names with NguonC prefix', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.ok(movie.streams[0].server_name.startsWith('NguonC'));
});

test('NguonC: parses actors from comma-separated string', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.ok(Array.isArray(movie.actors));
  assert.ok(movie.actors.length >= 2);
  assert.ok(movie.actors.includes('Hoàng Cảnh Du'));
});

test('NguonC: parses directors', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.ok(movie.directors.includes('Shen Yan'));
});

test('NguonC: normalizes title for identity matching', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.equal(movie.normalizedTitle, 'trong khi');
  assert.ok(movie.normalizedOriginalTitle.includes('forging'));
});

test('NguonC: detects single movie type', () => {
  const payload = {
    movie: {
      name: 'Test Single',
      slug: 'test-single',
      category: {
        1: { group: { name: 'Định dạng' }, list: [{ name: 'Phim lẻ' }] }
      },
      episodes: []
    }
  };
  const movie = normalizeNguonc(payload);
  assert.equal(movie.displayType, 'single');
  assert.equal(movie.mediaType, 'movie');
});

test('NguonC: detects hoathinh type', () => {
  const payload = {
    movie: {
      name: 'Test Anime',
      slug: 'test-anime',
      category: {
        1: { group: { name: 'Định dạng' }, list: [{ name: 'Hoạt Hình' }] }
      },
      episodes: []
    }
  };
  const movie = normalizeNguonc(payload);
  assert.equal(movie.displayType, 'hoathinh');
});

test('NguonC: detects tvshows type', () => {
  const payload = {
    movie: {
      name: 'Test Show',
      slug: 'test-show',
      category: {
        1: { group: { name: 'Định dạng' }, list: [{ name: 'TV Shows' }] }
      },
      episodes: []
    }
  };
  const movie = normalizeNguonc(payload);
  assert.equal(movie.displayType, 'tvshows');
});

test('NguonC: preserves providerUpdatedAt', () => {
  const movie = normalizeNguonc(fixture('nguonc-detail.json'));
  assert.equal(movie.providerUpdatedAt, '2026-08-14T11:59:22.000000Z');
});

test('NguonC: handles missing category groups gracefully', () => {
  const movie = normalizeNguonc({ movie: { name: 'Bare', slug: 'bare' } });
  assert.equal(movie.title, 'Bare');
  assert.deepEqual(movie.genres, []);
  assert.deepEqual(movie.countries, []);
});

test('NguonC: filters empty stream servers', () => {
  const payload = {
    movie: {
      name: 'No Eps',
      slug: 'no-eps',
      episodes: [{ server_name: 'Empty', items: [] }]
    }
  };
  const movie = normalizeNguonc(payload);
  assert.equal(movie.streams.length, 0);
});

// --- KKPhim normalization ---

test('KKPhim: swaps poster_url and thumb_url (known field swap)', () => {
  const payload = fixture('kkphim-detail.json');
  const movie = normalizeKkphim(payload);
  assert.equal(movie.thumbSourceUrl, payload.movie.poster_url);
  assert.equal(movie.posterSourceUrl, payload.movie.thumb_url);
});

test('KKPhim: preserves TMDB identity', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.equal(movie.tmdbId, 273119);
  assert.equal(movie.tmdbMediaType, 'tv');
  assert.equal(movie.tmdbSeasonNumber, 1);
});

test('KKPhim: preserves IMDb identity', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.equal(movie.imdbId, 'tt31886947');
});

test('KKPhim: extracts ratings into ratings object', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.equal(movie.ratings.tmdb, 8.1);
  assert.equal(movie.ratings.imdb, 7.8);
  assert.equal(movie.ratings.tmdb_count, 10);
  assert.equal(movie.ratings.imdb_count, 20);
});

test('KKPhim: normalizes stream names with KKPhim prefix', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.ok(movie.streams[0].server_name.startsWith('KKPhim'));
});

test('KKPhim: extracts genres from category array', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.equal(movie.genres[0].name, 'Chính Kịch');
  assert.equal(movie.genres[0].slug, 'chinh-kich');
});

test('KKPhim: extracts actors from array', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.ok(movie.actors.includes('Huangyang Tiantian'));
});

test('KKPhim: handles missing TMDB data gracefully', () => {
  const movie = normalizeKkphim({ movie: { name: 'Bare', slug: 'bare' } });
  assert.equal(movie.tmdbId, null);
  assert.equal(movie.imdbId, null);
  assert.equal(movie.tmdbMediaType, null);
  assert.equal(movie.tmdbSeasonNumber, null);
});

test('KKPhim: handles missing episodes', () => {
  const movie = normalizeKkphim({ movie: { name: 'No Eps', slug: 'no-eps' } });
  assert.equal(movie.streams.length, 0);
});

test('KKPhim: generates slugs via slugify for genre labels', () => {
  const movie = normalizeKkphim({
    movie: {
      name: 'Test',
      slug: 'test',
      category: [{ name: 'Viễn Tưởng' }]
    }
  });
  assert.ok(movie.genres[0].slug);
  assert.ok(!movie.genres[0].slug.includes(' '));
});

test('KKPhim: deduplicates genre slugs', () => {
  const movie = normalizeKkphim({
    movie: {
      name: 'Test',
      slug: 'test',
      category: [
        { name: 'Action', slug: 'action' },
        { name: 'Action Dup', slug: 'action' }
      ]
    }
  });
  assert.equal(movie.genres.length, 1);
});

test('KKPhim: providerUpdatedAt from modified.time', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.equal(movie.providerUpdatedAt, '2026-08-14T17:48:19.000Z');
});

test('KKPhim: compacts metadata excluding nulls', () => {
  const movie = normalizeKkphim(fixture('kkphim-detail.json'));
  assert.ok(movie.metadata);
  assert.ok(!Object.values(movie.metadata).includes(null));
  assert.ok(!Object.values(movie.metadata).includes(undefined));
  assert.ok(!Object.values(movie.metadata).includes(''));
});

// --- Provider TMDB / IMDb identity (NguonC added these fields in 2026-11) ---

test('NguonC: reads the tmdb and imdb blocks of list items and details', () => {
  const movie = normalizeNguonc({ movie: {
    id: 'bff5992111ba4c548364f2a68998634b', slug: 'nguoi-me-khac-2026', name: 'Người Mẹ Khác',
    tmdb: { id: 1400837, type: 'movie', season: null, url: 'https://www.themoviedb.org/movie/1400837' },
    imdb: { id: 'tt36586020', url: 'https://www.imdb.com/title/tt36586020/' }
  } });
  assert.equal(movie.tmdbId, 1400837);
  assert.equal(movie.tmdbMediaType, 'movie');
  assert.equal(movie.tmdbSeasonNumber, null);
  assert.equal(movie.imdbId, 'tt36586020');
  assert.equal(movie.metadata.tmdb_id, 1400837);
  assert.equal(movie.metadata.tmdb_type, 'movie');
  assert.equal(movie.metadata.imdb_id, 'tt36586020');
  assert.equal('tmdb_season' in movie.metadata, false);
});

test('NguonC: a tv season is kept, season 0 (Specials) is treated as unknown', () => {
  const tv = (season) => normalizeNguonc({ movie: { slug: 'x', name: 'X', tmdb: { id: '99', type: 'TV', season } } });
  assert.equal(tv(3).tmdbSeasonNumber, 3);
  assert.equal(tv(3).tmdbMediaType, 'tv');
  assert.equal(tv(3).tmdbId, 99);
  assert.equal(tv(0).tmdbSeasonNumber, null);
  assert.equal(tv(0).metadata.tmdb_season, undefined);
  assert.equal(tv('').tmdbSeasonNumber, null);
});

test('provider identity: junk ids are dropped, metadata stores the normalized claim', () => {
  const kk = normalizeKkphim({ movie: { slug: 'y', name: 'Y', tmdb: { id: '0', type: 'serie', season: '2' }, imdb: { id: ' TT0111161 ' } } });
  assert.equal(kk.tmdbId, null);
  assert.equal(kk.tmdbMediaType, null);
  assert.equal(kk.tmdbSeasonNumber, 2);
  assert.equal(kk.imdbId, 'tt0111161');
  assert.equal(kk.metadata.imdb_id, 'tt0111161');
  assert.equal(kk.metadata.tmdb_season, 2);
  assert.equal(normalizeKkphim({ movie: { slug: 'z', name: 'Z', imdb: { id: 'N/A' } } }).imdbId, null);
  assert.equal(normalizeNguonc({ movie: { slug: 'z', name: 'Z', imdb: { id: '' }, tmdb: null } }).imdbId, null);
});
