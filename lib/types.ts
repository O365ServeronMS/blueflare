export type MovieCard = {
  name: string;
  originName?: string;
  slug: string;
  poster: string;
  thumb: string;
  posterSigned?: { m: string; d: string };
  thumbSigned?: { m: string; d: string };
  year?: number | string;
  quality?: string;
  lang?: string;
  type?: string;
  status?: string;
  episodeCurrent?: string;
  time?: string;
  imdbRating?: number;
  tmdbRating?: number;
  tmdb?: { id?: number | string; type?: string; vote_average?: number; vote_count?: number };
  imdb?: { id?: string; rating?: number; vote_count?: number };
  /** Rotten Tomatoes critic score (0-100) from MDBList. */
  tomatometer?: number;
  /** Rotten Tomatoes audience score (0-100) from MDBList. */
  audienceScore?: number;
  rating?: { imdb?: number | string; tmdb?: number | string } | number | string;
  ratings?: { imdb?: number | string; tmdb?: number | string };
  country?: string;
  category?: string;
  /** Synopsis; present on detail payloads and on home hero cards only. */
  content?: string;
};

export type Episode = {
  name: string;
  slug?: string;
  filename?: string;
  linkEmbed?: string;
  linkM3u8?: string;
};

export type EpisodeServer = {
  serverName: string;
  serverData: Episode[];
};

export type MovieDetail = MovieCard & {
  actor?: string[];
  director?: string[];
  episodeTotal?: string;
  categoryList?: { id?: string; name: string; slug: string }[];
  countryList?: { id?: string; name: string; slug: string }[];
  episodes: EpisodeServer[];
};

export type HomePayload = {
  hero: MovieCard[];
  sections: { title: string; href: string; items: MovieCard[] }[];
};

export type ListPayload = {
  title: string;
  items: MovieCard[];
  page: number;
  totalPages?: number;
};

export type SourceLabel = {
  id?: string;
  name?: string;
  slug?: string;
};

export type SourceRating = {
  id?: number | string;
  tmdb_id?: number | string;
  vote_average?: number | string;
  vote_count?: number | string;
  rating?: number | string;
};

export type SourceMovie = {
  _id?: string;
  id?: string;
  name?: string;
  title?: string;
  origin_name?: string;
  originName?: string;
  original_name?: string;
  slug?: string;
  posterUrl?: string;
  poster_url?: string;
  poster?: string;
  thumbUrl?: string;
  thumb_url?: string;
  thumb?: string;
  thumbnail?: string;
  image?: string;
  image_url?: string;
  year?: number | string;
  publish_year?: number | string;
  quality?: string;
  video_quality?: string;
  quality_name?: string;
  lang?: string;
  language?: string;
  type?: string;
  type_slug?: string;
  status?: string;
  episode_current?: string;
  episodeCurrent?: string;
  time?: string;
  duration?: string;
  tmdb?: SourceRating;
  tmdb_rating?: SourceRating;
  tmdbRating?: number | string;
  tmdb_vote_average?: number | string;
  vote_average?: number | string;
  rating?: SourceRating | number | string;
  ratings?: { imdb?: number | string; tmdb?: number | string };
  tmdb_id?: number | string;
  imdb?: SourceRating;
  rotten?: {
    tomatometer?: number | string | null;
    audience?: number | string | null;
  };
  imdb_rating?: SourceRating | number | string;
  imdbRating?: number | string;
  imdb_score?: number | string;
  category?: SourceLabel[] | string;
  country?: SourceLabel[] | string;
  content?: string;
  description?: string;
  actor?: string[];
  director?: string[];
  episode_total?: string;
  episodeTotal?: string;
};

export type SourceEpisode = {
  name?: string;
  slug?: string;
  filename?: string;
  link_embed?: string;
  linkEmbed?: string;
  link_m3u8?: string;
  linkM3u8?: string;
};

export type SourceEpisodeServer = {
  server_data?: SourceEpisode[];
  serverData?: SourceEpisode[];
};

export type SourcePagination = {
  currentPage?: number | string;
  totalPages?: number | string;
  total_pages?: number | string;
};

export type SourceListData = {
  items?: SourceMovie[];
  movies?: SourceMovie[];
  APP_DOMAIN_CDN_IMAGE?: string;
  params?: { pagination?: SourcePagination };
  pagination?: SourcePagination;
};

export type SourceListPayload = SourceListData & {
  data?: SourceListData;
};

export type SourceMovieData = SourceMovie & {
  item?: SourceMovie;
  movie?: SourceMovie;
  episodes?: SourceEpisodeServer[];
  APP_DOMAIN_CDN_IMAGE?: string;
};

export type SourceMoviePayload = {
  movie?: SourceMovie;
  episodes?: SourceEpisodeServer[];
  APP_DOMAIN_CDN_IMAGE?: string;
  data?: SourceMovieData;
};

export type SourceTaxonomyPayload = SourceLabel[] | {
  data?: SourceLabel[];
};
