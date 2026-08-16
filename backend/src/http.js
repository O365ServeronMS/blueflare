export class HttpError extends Error {
  constructor(message, status, url, retryAfterMs = 0) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

const nextRequestAtByOrigin = new Map();

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

async function respectRequestInterval(url, minIntervalMs) {
  if (!minIntervalMs) return;
  const origin = new URL(url).origin;
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAtByOrigin.get(origin) || now);
  nextRequestAtByOrigin.set(origin, scheduledAt + minIntervalMs);
  const delay = scheduledAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const retries = options.retries ?? 2;
  const minIntervalMs = options.minIntervalMs || 0;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      await respectRequestInterval(url, minIntervalMs);
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'BlueflareCatalog/1.0'
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new HttpError(
          'Provider returned HTTP ' + response.status,
          response.status,
          url,
          retryAfterMs(response.headers.get('retry-after'))
        );
      }
      const data = await response.json();
      return { data, latencyMs: Date.now() - started, status: response.status };
    } catch (error) {
      lastError = error;
      const retryable = error?.name === 'AbortError' || !error?.status || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
      if (attempt >= retries || !retryable) break;
      const backoffMs = Math.max(
        error?.retryAfterMs || 0,
        Math.min(5000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 100)
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}
