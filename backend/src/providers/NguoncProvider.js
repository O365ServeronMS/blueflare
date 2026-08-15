import { config } from '../config.js';
import { fetchJson } from '../http.js';
import { normalizeNguonc } from '../normalize.js';
import { MovieProvider } from './MovieProvider.js';

export class NguoncProvider extends MovieProvider {
  constructor() {
    super('nguonc', 10);
    this.baseUrl = config.nguoncBaseUrl;
  }

  async list(type = 'phim-moi-cap-nhat', page = 1) {
    const path = type === 'phim-moi-cap-nhat'
      ? '/api/films/phim-moi-cap-nhat'
      : '/api/films/danh-sach/' + encodeURIComponent(type);
    return fetchJson(this.baseUrl + path + '?page=' + page, {
      timeoutMs: config.requestTimeoutMs
    });
  }

  async syncLatest(page = 1) {
    return this.list('phim-moi-cap-nhat', page);
  }

  async detail(slug) {
    const response = await fetchJson(
      this.baseUrl + '/api/film/' + encodeURIComponent(slug),
      { timeoutMs: config.requestTimeoutMs }
    );
    return {
      ...response,
      normalized: normalizeNguonc(response.data)
    };
  }

  async search(keyword) {
    return fetchJson(
      this.baseUrl + '/api/films/search?keyword=' + encodeURIComponent(keyword),
      { timeoutMs: config.requestTimeoutMs }
    );
  }

  listItems(payload) {
    return this.expectArray(payload?.items, 'items[]');
  }
}
