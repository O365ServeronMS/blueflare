import { createHash } from 'node:crypto';
import { utcDay, nextUtcMidnight } from '../aiQuotaLedger.js';

export { utcDay, nextUtcMidnight };

const FREE_RPM = 20; // OpenRouter free tier: ~20 requests/minute per account
const DAILY_RETRY_DELAY_MS = 10 * 60 * 1000;

/** `:free` variants and OpenRouter's free router `openrouter/free`, which picks a free model per request. */
export const isFree = (id) => /:free$/.test(id) || id === 'openrouter/free';

/** Key list from a comma string (or array): trimmed, empties dropped, deduped, order kept. */
export function parseKeys(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

/** Non-reversible short id of a key for logs: first 6 hex of sha256. Never any part of the key itself. */
export const keyFingerprint = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 6);

/** Quota-ledger id of a key for one purpose: two roles never share counters even on one key. */
export const scopedFingerprint = (key, scope) => createHash('sha256').update(String(scope) + ':' + String(key)).digest('hex').slice(0, 12);

/**
 * Ordered model list `id[:rpm[:rpd]]` (the id itself may end in `:free`). rpm 0 = no spacing.
 * `freeRpm` is the spacing a `:free` model gets when the entry names none (OpenRouter only).
 */
export function parseModels(value, { freeRpm = FREE_RPM } = {}) {
  const seen = new Set();
  const out = [];
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  for (const raw of entries) {
    const text = (typeof raw === 'string' ? raw : `${raw.id}:${raw.rpm ?? ''}:${raw.rpd ?? ''}`).trim();
    if (!text) continue;
    // `vendor/model[:free][:rpm[:rpd]]`: numeric trailing parts are limits, anything else belongs to the id.
    const parts = text.split(':');
    const id = [parts.shift()];
    while (parts.length && !/^\d+$/.test(parts[0])) id.push(parts.shift());
    const modelId = id.join(':').trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const rpm = Number(parts[0]);
    const entry = { id: modelId, rpm: parts[0] !== undefined && parts[0] !== '' && Number.isFinite(rpm) && rpm >= 0 ? rpm : (isFree(modelId) ? freeRpm : 0) };
    const rpd = Number(parts[1]);
    if (parts[1] && Number.isFinite(rpd) && rpd > 0) entry.rpd = rpd;
    out.push(entry);
  }
  return out;
}

/** { daily, delayMs } of a 429: Retry-After (s), then X-RateLimit-Reset (ms epoch) from the body or headers. */
export function classifyRateLimit(raw, headers, t = Date.now()) {
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  const header = (name) => headers?.get?.(name) ?? null;
  let delayMs = null;
  const retryAfter = Number(header('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) delayMs = Math.round(retryAfter * 1000);
  const reset = Number(json?.error?.metadata?.headers?.['X-RateLimit-Reset'] ?? header('x-ratelimit-reset'));
  if (delayMs == null && Number.isFinite(reset) && reset > t) delayMs = Math.round(reset - t);
  const message = String(json?.error?.message ?? raw ?? '');
  const daily = /per-?day|daily/i.test(message) || (delayMs != null && delayMs > DAILY_RETRY_DELAY_MS);
  return { daily, delayMs };
}

/** Token counts and cost of a chat completion. A provider that reports no cost gives `cost: null`. */
export function usageOf(json) {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const thoughtTokens = num(u.completion_tokens_details?.reasoning_tokens);
  const totalTokens = num(u.total_tokens) ?? (promptTokens != null ? promptTokens + (completionTokens ?? 0) : null);
  return { promptTokens, completionTokens, thoughtTokens, totalTokens, cost: num(u.cost) };
}

/** Plain text of a message content (string or content parts), without `<think>` blocks. */
export function contentText(content) {
  const text = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** First JSON value in a model answer: the whole text, a ```json fence, then the outer {...} or [...]. */
export function extractJson(text) {
  const clean = String(text ?? '').trim();
  const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const span = (open, close) => {
    const start = clean.indexOf(open);
    const end = clean.lastIndexOf(close);
    return start >= 0 && end > start ? clean.slice(start, end + 1) : '';
  };
  for (const attempt of [clean, fence, span('{', '}'), span('[', ']')]) {
    if (!attempt) continue;
    try { return { ok: true, value: JSON.parse(attempt) }; } catch { /* next */ }
  }
  return { ok: false, value: undefined };
}

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

/**
 * Small JSON-schema subset (type, properties, required, items, enum, anyOf) used to check a model
 * answer before it reaches the caller. Returns the first problem as a string, or null.
 */
export function checkSchema(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((s) => checkSchema(s, value, path) == null) ? null : path + ': matches no anyOf branch';
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) return path + ': expected ' + types.join('|') + ', got ' + actual;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) return path + ': not in enum';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? []) if (!(name in value)) return path + '.' + name + ': required';
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (name in value) {
        const problem = checkSchema(sub, value[name], path + '.' + name);
        if (problem) return problem;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const problem = checkSchema(schema.items, value[i], path + '[' + i + ']');
      if (problem) return problem;
    }
  }
  return null;
}

/** Image MIME type from magic bytes (png, jpeg, gif, webp); null when unknown. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
