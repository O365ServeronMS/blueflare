export class ImageSourceError extends Error {
  constructor(status) {
    super('Image source returned HTTP ' + status);
    this.name = 'ImageSourceError';
    this.status = status;
  }
}

// 404/410: nguồn đã mất, nhớ lâu. 429: nhớ ngắn và bảo client thử lại sau. Còn lại: lỗi tạm.
export function classifySourceFailure(status) {
  if (status === 404 || status === 410) return { responseStatus: 404, ttlMs: 60 * 60 * 1000 };
  if (status === 429) return { responseStatus: 503, ttlMs: 60 * 1000, retryAfterSeconds: 60 };
  return { responseStatus: 502, ttlMs: 30 * 1000 };
}

export function createFailureMemo({ max = 5000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.until <= now()) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    remember(key, status) {
      const failure = classifySourceFailure(status);
      const fresh = !this.get(key);
      entries.delete(key);
      entries.set(key, { ...failure, status, until: now() + failure.ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value);
      return fresh;
    }
  };
}
