export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const retries = options.retries ?? 2;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
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
          url
        );
      }
      const data = await response.json();
      return { data, latencyMs: Date.now() - started, status: response.status };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}
