import { config } from '../config.js';
import { fetchJson } from '../http.js';
import { normalizeKkphim } from '../normalize.js';
import { MovieProvider } from './MovieProvider.js';

export class KkphimProvider extends MovieProvider {
  constructor() {
    super('kkphim', 20);
    this.baseUrl = config.kkphimBaseUrl;
  }

  async list(type = 'phim-moi-cap-nhat', page = 1) {
    const path = type === 'phim-moi-cap-nhat'
      ? '/danh-sach/phim-moi-cap-nhat-v3'
      : '/v1/api/danh-sach/' + encodeURIComponent(type);
    return fetchJson(this.baseUrl + path + '?page=' + page, {
      timeoutMs: config.requestTimeoutMs,
      minIntervalMs: config.kkphimRequestMinIntervalMs
    });
  }

  async syncLatest(page = 1) {
    return this.list('phim-moi-cap-nhat', page);
  }

  async detail(slug) {
    const response = await fetchJson(
      this.baseUrl + '/phim/' + encodeURIComponent(slug),
      { timeoutMs: config.requestTimeoutMs, minIntervalMs: config.kkphimRequestMinIntervalMs }
    );
    return {
      ...response,
      normalized: normalizeKkphim(response.data)
    };
  }

  async search(keyword, page = 1) {
    return fetchJson(
      this.baseUrl + '/v1/api/tim-kiem?keyword=' +
        encodeURIComponent(keyword) + '&page=' + page,
      { timeoutMs: config.requestTimeoutMs, minIntervalMs: config.kkphimRequestMinIntervalMs }
    );
  }

  listItems(payload) {
    const items = Array.isArray(payload?.items)
      ? payload.items : payload?.data?.items;
    return this.expectArray(items, 'items[] or data.items[]');
  }
}
