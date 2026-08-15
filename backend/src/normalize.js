import { mediaFamily, normalizeTitle, slugify } from './identity.js';

function value(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function people(raw) {
  if (Array.isArray(raw)) return raw.map(value).filter(Boolean);
  return String(raw || '')
    .split(',')
    .map(value)
    .filter(Boolean);
}

function label(name, slug) {
  const cleanName = value(name);
  if (!cleanName) return null;
  return {
    name: cleanName,
    slug: value(slug) || slugify(cleanName)
  };
}

function uniqueLabels(labels) {
  const seen = new Set();
  return labels.filter(Boolean).filter((item) => {
    if (seen.has(item.slug)) return false;
    seen.add(item.slug);
    return true;
  });
}

function nguoncGroups(movie) {
  return Object.values(movie.category || {}).map((entry) => ({
    name: normalizeTitle(entry?.group?.name),
    list: Array.isArray(entry?.list) ? entry.list : []
  }));
}

function nguoncGroup(groups, groupName) {
  const normalized = normalizeTitle(groupName);
  return groups.find((group) => group.name === normalized)?.list || [];
}

function nguoncType(groups) {
  const names = nguoncGroup(groups, 'Định dạng').map((item) => normalizeTitle(item.name));
  if (names.some((name) => name.includes('phim le'))) return 'single';
  if (names.some((name) => name.includes('hoat hinh'))) return 'hoathinh';
  if (names.some((name) => name.includes('tv show'))) return 'tvshows';
  return 'series';
}

function normalizeNguoncStreams(raw) {
  return (Array.isArray(raw) ? raw : []).map((server) => ({
    server_name: 'NguonC · ' + (value(server.server_name) || 'Server'),
    server_data: (Array.isArray(server.items) ? server.items : []).map((episode, index) => ({
      name: value(episode.name) || String(index + 1),
      slug: value(episode.slug) || 'tap-' + (index + 1),
      filename: value(episode.filename),
      link_embed: value(episode.embed),
      link_m3u8: value(episode.m3u8)
    }))
  })).filter((server) => server.server_data.length);
}

function normalizeKkphimStreams(raw) {
  return (Array.isArray(raw) ? raw : []).map((server) => ({
    server_name: 'KKPhim · ' + (value(server.server_name) || 'Server'),
    server_data: (Array.isArray(server.server_data) ? server.server_data : []).map((episode, index) => ({
      name: value(episode.name) || String(index + 1),
      slug: value(episode.slug) || 'tap-' + (index + 1),
      filename: value(episode.filename),
      link_embed: value(episode.link_embed),
      link_m3u8: value(episode.link_m3u8)
    }))
  })).filter((server) => server.server_data.length);
}

function canonical(input) {
  const title = value(input.title) || value(input.originalTitle) || 'Không rõ tên';
  const originalTitle = value(input.originalTitle);
  const displayType = value(input.displayType) || 'series';
  return {
    provider: input.provider,
    priority: input.priority,
    providerMovieId: value(input.providerMovieId) || value(input.providerSlug),
    providerSlug: value(input.providerSlug),
    title,
    originalTitle,
    normalizedTitle: normalizeTitle(title),
    normalizedOriginalTitle: normalizeTitle(originalTitle),
    mediaType: mediaFamily(displayType),
    displayType,
    year: number(input.year),
    tmdbId: number(input.tmdbId),
    imdbId: value(input.imdbId),
    overview: value(input.overview),
    thumbSourceUrl: value(input.thumbSourceUrl),
    posterSourceUrl: value(input.posterSourceUrl),
    quality: value(input.quality),
    language: value(input.language),
    status: value(input.status),
    episodeCurrent: value(input.episodeCurrent),
    episodeTotal: value(input.episodeTotal),
    duration: value(input.duration),
    actors: input.actors || [],
    directors: input.directors || [],
    genres: uniqueLabels(input.genres || []),
    countries: uniqueLabels(input.countries || []),
    ratings: input.ratings || {},
    streams: input.streams || [],
    providerUpdatedAt: value(input.providerUpdatedAt),
    metadata: compactMetadata(input)
  };
}

function compactMetadata(input) {
  return Object.fromEntries(Object.entries({
    source_id: input.providerMovieId,
    source_slug: input.providerSlug,
    source_updated_at: input.providerUpdatedAt,
    title: input.title,
    original_title: input.originalTitle,
    year: input.year,
    type: input.displayType,
    quality: input.quality,
    language: input.language,
    status: input.status,
    episode_current: input.episodeCurrent,
    episode_total: input.episodeTotal,
    thumb_source_url: input.thumbSourceUrl,
    poster_source_url: input.posterSourceUrl
  }).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

export function normalizeNguonc(payload) {
  const movie = payload?.movie || payload || {};
  const groups = nguoncGroups(movie);
  const displayType = nguoncType(groups);
  const genres = nguoncGroup(groups, 'Thể loại').map((item) => label(item.name));
  const countries = nguoncGroup(groups, 'Quốc gia').map((item) => label(item.name));
  const yearFromGroup = nguoncGroup(groups, 'Năm')[0]?.name;

  return canonical({
    provider: 'nguonc',
    priority: 10,
    providerMovieId: movie.id || movie.slug,
    providerSlug: movie.slug,
    title: movie.name,
    originalTitle: movie.original_name,
    displayType,
    year: movie.year || yearFromGroup,
    overview: movie.description,
    thumbSourceUrl: movie.thumb_url,
    posterSourceUrl: movie.poster_url,
    quality: movie.quality,
    language: movie.language,
    status: movie.current_episode,
    episodeCurrent: movie.current_episode,
    episodeTotal: movie.total_episodes,
    duration: movie.time,
    actors: people(movie.casts),
    directors: people(movie.director),
    genres,
    countries,
    streams: normalizeNguoncStreams(movie.episodes),
    providerUpdatedAt: movie.modified,
    metadata: movie
  });
}

export function normalizeKkphim(payload) {
  const movie = payload?.movie || payload || {};
  return canonical({
    provider: 'kkphim',
    priority: 20,
    providerMovieId: movie._id || movie.slug,
    providerSlug: movie.slug,
    title: movie.name,
    originalTitle: movie.origin_name,
    displayType: movie.type,
    year: movie.year,
    tmdbId: movie.tmdb?.id,
    imdbId: movie.imdb?.id,
    overview: movie.content,
    thumbSourceUrl: movie.poster_url,
    posterSourceUrl: movie.thumb_url,
    quality: movie.quality,
    language: movie.lang,
    status: movie.status,
    episodeCurrent: movie.episode_current,
    episodeTotal: movie.episode_total,
    duration: movie.time,
    actors: people(movie.actor),
    directors: people(movie.director),
    genres: (movie.category || []).map((item) => label(item.name, item.slug)),
    countries: (movie.country || []).map((item) => label(item.name, item.slug)),
    ratings: {
      tmdb: number(movie.tmdb?.vote_average),
      tmdb_count: number(movie.tmdb?.vote_count),
      imdb: number(movie.imdb?.vote_average),
      imdb_count: number(movie.imdb?.vote_count)
    },
    streams: normalizeKkphimStreams(payload?.episodes),
    providerUpdatedAt: movie.modified?.time,
    metadata: movie
  });
}
