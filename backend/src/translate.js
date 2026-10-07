import { config } from './config.js';

/** Provider-side limit per request; stays well under URL/body caps for gtx. */
export const TRANSLATE_CHUNK_MAX = 4000;

/** The provider refused us (rate limit, captcha, forbidden): stop hammering it. */
export class TranslateBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranslateBlockedError';
    this.blocked = true;
  }
}

function hardSplit(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Fragments of one paragraph, each <= max, cut on sentence ends where possible. */
function paragraphFragments(paragraph, max) {
  if (paragraph.length <= max) return [paragraph];
  const out = [];
  let buf = '';
  for (const sentence of paragraph.split(/(?<=[.!?…])\s+/)) {
    for (const piece of sentence.length > max ? hardSplit(sentence, max) : [sentence]) {
      if (buf && buf.length + 1 + piece.length > max) {
        out.push(buf);
        buf = piece;
      } else {
        buf = buf ? buf + ' ' + piece : piece;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Chunks of at most `max` chars. `joiner` is what separated the chunk from the
 * previous one in the source: '\n' at a paragraph break, ' ' inside a paragraph.
 */
export function planChunks(text, max = TRANSLATE_CHUNK_MAX) {
  const fragments = [];
  String(text ?? '').trim().split('\n').forEach((line) => {
    paragraphFragments(line.trim(), max).forEach((fragment, index) => {
      fragments.push({ text: fragment, joiner: index === 0 ? '\n' : ' ' });
    });
  });
  const chunks = [];
  let current = null;
  for (const fragment of fragments) {
    if (current && current.text.length + fragment.joiner.length + fragment.text.length <= max) {
      current.text += fragment.joiner + fragment.text;
    } else {
      current = { text: fragment.text, joiner: current ? fragment.joiner : '' };
      chunks.push(current);
    }
  }
  return chunks;
}

export function splitIntoChunks(text, max = TRANSLATE_CHUNK_MAX) {
  return planChunks(text, max).map((chunk) => chunk.text);
}

/** gtx answers [[[translated, source, ...], ...], ...]; the translation is the joined segments. */
export function parseGtxResponse(json) {
  const segments = Array.isArray(json) ? json[0] : null;
  if (!Array.isArray(segments)) throw new Error('unexpected translate response shape');
  let out = '';
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === 'string') out += segment[0];
  }
  return out;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Free unofficial Google endpoint. One POST per chunk (form body, so no URL
 * length limit). 429/403 or an HTML page (captcha / consent) means blocked.
 */
export function googleGtxProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? config.translateTimeoutMs;
  const endpoint = options.endpoint ?? 'https://translate.googleapis.com/translate_a/single';
  return async function translateChunk(text) {
    const response = await fetchImpl(endpoint + '?client=gtx&sl=en&tl=vi&dt=t', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'q=' + encodeURIComponent(text),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status === 429 || response.status === 403) {
      throw new TranslateBlockedError('translate blocked: HTTP ' + response.status);
    }
    const type = String(response.headers?.get?.('content-type') || '');
    if (/text\/html/i.test(type)) throw new TranslateBlockedError('translate blocked: html response');
    if (!response.ok) {
      const error = new Error('translate HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    const body = await response.text();
    if (/^\s*</.test(body)) throw new TranslateBlockedError('translate blocked: html response');
    let json;
    try { json = JSON.parse(body); } catch { throw new Error('translate response is not JSON'); }
    return parseGtxResponse(json);
  };
}

const PROVIDERS = { 'google-gtx': googleGtxProvider };

/**
 * `translate(text) -> string`: chunk, call the provider per chunk with retries
 * (backoff) on transient errors, rejoin keeping paragraph breaks. Blocked
 * errors are never retried.
 */
export function createTranslator(options = {}) {
  const name = options.provider ?? config.translateProvider;
  const factory = options.providerFactory ?? PROVIDERS[name];
  if (!factory) throw new Error('unknown TRANSLATE_PROVIDER: ' + name);
  const chunkFn = options.chunkFn ?? factory(options);
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const sleep = options.sleep ?? sleepMs;

  async function withRetry(chunk) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await chunkFn(chunk);
      } catch (error) {
        if (error.blocked || attempt >= retries) throw error;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  }

  return async function translate(text) {
    let out = '';
    for (const chunk of planChunks(text, options.chunkMax ?? TRANSLATE_CHUNK_MAX)) {
      // Edge newlines (blank lines at a chunk boundary) are re-applied from the source: the provider's trim is not trusted.
      const lead = chunk.text.match(/^\n*/)[0];
      const trail = chunk.text.match(/\n*$/)[0];
      const body = chunk.text.trim();
      out += chunk.joiner + (body ? lead + (await withRetry(body)).trim() + trail : chunk.text);
    }
    return out;
  };
}
