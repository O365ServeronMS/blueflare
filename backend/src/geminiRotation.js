import { createHash } from 'node:crypto';
import { parseApiKeys } from './config.js';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_MODEL_RPM = 5;
const SPACING_MARGIN_MS = 250;
/** Wait on the best model only when its RPM spacing ends within this; otherwise use the next ready one. */
const PREFER_WAIT_MS = 3000;
/** Never sleep longer than this inside one request: the provider reports blocked instead. */
const MAX_SPACING_WAIT_MS = 30000;
const GEMMA_CHUNK_MAX = 6000;
const GEMMA_TPM = 16000;
const FLASH_TPM = 250000;
const UNKNOWN_429_COOLDOWN_MS = 60000;
const DAILY_RETRY_DELAY_MS = 10 * 60 * 1000;
/** Overload (5xx, 'high demand'), timeouts and network errors park the pair briefly, doubling on repeats. */
const TRANSIENT_PARK_MS = 45000;
const TRANSIENT_PARK_MAX_MS = 5 * 60 * 1000;

/** Google error bodies carry details[].retryDelay as "34s" / "34.5s". Returns ms or null. */
export function parseRetryDelayMs(body) {
  let json = body;
  if (typeof body === 'string') {
    try { json = JSON.parse(body); } catch { return null; }
  }
  const details = json?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(String(detail?.retryDelay ?? ''));
    if (match) return Math.round(Number(match[1]) * 1000);
  }
  return null;
}

/** GEMINI_MODELS: ordered `id[:rpm]`, duplicates dropped, rpm defaults to a conservative 5. */
export function parseGeminiModels(value) {
  const seen = new Set();
  const out = [];
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  for (const raw of entries) {
    const [idPart, rpmPart] = (typeof raw === 'string' ? raw : `${raw.id}:${raw.rpm ?? ''}`).trim().split(':');
    const id = idPart.trim().replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rpm = Number(rpmPart);
    out.push({ id, rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : DEFAULT_MODEL_RPM });
  }
  return out;
}

export const isGemma = (id) => /^gemma/i.test(id);

const PACIFIC = 'America/Los_Angeles';
const pacificFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric'
});

function pacificParts(ts) {
  const parts = {};
  for (const part of pacificFormat.formatToParts(new Date(ts))) parts[part.type] = Number(part.value);
  return parts;
}

function pacificOffsetMs(ts) {
  const p = pacificParts(ts);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** Next 00:00 America/Los_Angeles strictly after `ts` (when free-tier daily quotas reset), DST aware. */
export function nextPacificMidnight(ts) {
  const p = pacificParts(ts);
  const wall = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
  const guess = wall - pacificOffsetMs(wall);
  return wall - pacificOffsetMs(guess);
}

/**
 * Reads a Gemini 429 body: per-minute limits give a retry delay, daily quota
 * (PerDay metric/id, or a delay over 10 minutes) lasts until Pacific midnight.
 */
export function classifyQuotaError(raw) {
  const delayMs = parseRetryDelayMs(raw);
  const daily = /PerDay/i.test(String(raw)) || (delayMs != null && delayMs > DAILY_RETRY_DELAY_MS);
  return { daily, delayMs };
}

/** Non-reversible short id of a key for logs: first 6 hex of sha256. Never any part of the key itself. */
export function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 6);
}


/**
 * Shared Gemini free-tier rotation over several API keys and models (see
 * `geminiProvider` in translate.js for the full behaviour description). Every
 * call to this factory owns its own state (`options.state`, a fresh object by
 * default), so two consumers never share cooldowns or spacing. Callers supply
 * the error classes and prompt shape:
 *  - `options.blockedError(message)`: error thrown when no key/model can serve;
 *    `retryAfterMs`/`status` are set on it here.
 *  - `options.contentError(message)`: per-text refusal (e.g. text too long for gemma).
 *  - `options.isContentError(error)`: true for errors `parse` throws that mean "this model
 *    refused, try the next model".
 *  - `options.modelsName`: env name used in the "empty" error message.
 * The returned `call({ text, buildBody(model), parse(json), meta })` returns
 * `parse(json)` of the first pair that answers; `meta.model` / `meta.key` are set.
 */
export function createGeminiRotation(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKeys = parseApiKeys(options.apiKeys);
  const models = parseGeminiModels(options.models);
  const timeoutMs = options.timeoutMs;
  const maxCooldownMs = options.cooldownMs;
  const floorMs = options.delayMs ?? 0;
  const base = options.endpoint ?? GEMINI_BASE;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepMs;
  const warn = options.warn ?? ((message) => console.warn(message));
  const makeBlocked = options.blockedError ?? ((message) => Object.assign(new Error(message), { blocked: true }));
  const makeContent = options.contentError ?? ((message) => Object.assign(new Error(message), { permanent: true }));
  const isContentError = options.isContentError ?? ((error) => error?.permanent === true);
  const transientBaseMs = options.transientParkMs ?? TRANSIENT_PARK_MS;
  const transientMaxMs = options.transientParkMaxMs ?? TRANSIENT_PARK_MAX_MS;
  const state = options.state ?? {};
  state.models ??= {};
  state.keys ??= {};
  state.pairs ??= {};
  if (!models.length) throw new Error((options.modelsName ?? 'GEMINI_MODELS') + ' is empty');
  if (!apiKeys.length) throw new Error('no Gemini API key');
  for (const model of models) state.models[model.id] ??= { until: 0, reason: '', announcedUntil: 0 };
  const keys = apiKeys.map((value, index) => {
    const fingerprint = keyFingerprint(value);
    state.keys[fingerprint] ??= { until: 0, announcedUntil: 0 };
    return { value, fingerprint, name: 'k' + (index + 1), label: 'k' + (index + 1) + ' (' + fingerprint + ')' };
  });
  const pairOf = (key, model) => (state.pairs[key.fingerprint + '|' + model.id] ??= { until: 0, nextAt: 0, announcedUntil: 0, transientFails: 0 });

  const clampDelay = (ms) => Math.min(Math.max(ms, 1000), maxCooldownMs);
  const blocked = (message, retryAfterMs, status) => {
    const error = makeBlocked(message);
    error.retryAfterMs = clampDelay(retryAfterMs);
    if (status) error.status = status;
    return error;
  };
  const spacingMs = (model, text) => {
    const tokens = Math.ceil(String(text).length / 3) + 300; // rough: review + prompt
    const tpm = isGemma(model.id) ? GEMMA_TPM : FLASH_TPM;
    return Math.max(Math.ceil(60000 / model.rpm) + SPACING_MARGIN_MS, floorMs, Math.ceil((tokens / tpm) * 60000));
  };
  const parkPair = (key, model, until, reason) => {
    const pair = pairOf(key, model);
    pair.until = until;
    if (pair.announcedUntil !== until) {
      pair.announcedUntil = until;
      warn('[worker] gemini ' + key.label + ' model ' + model.id + ' ' + reason + ' until ' + new Date(until).toISOString());
    }
  };
  const parkModel = (model, until, reason) => {
    const entry = state.models[model.id];
    entry.until = until;
    entry.reason = reason;
    if (entry.announcedUntil !== until) {
      entry.announcedUntil = until;
      warn('[worker] gemini model ' + model.id + ' ' + reason + ' until ' + new Date(until).toISOString());
    }
  };
  // Overload/timeout/network: park this pair 45s, 90s, 180s ... (capped), then try another pair in the same call.
  const parkTransient = (key, model, reason) => {
    const pair = pairOf(key, model);
    pair.transientFails = (pair.transientFails ?? 0) + 1;
    const ms = Math.min(transientBaseMs * 2 ** (pair.transientFails - 1), transientMaxMs, maxCooldownMs);
    parkPair(key, model, now() + ms, reason);
  };
  const keyUntil = (key) => state.keys[key.fingerprint].until;

  return async function call({ text, buildBody, parse, meta = {} }) {
    const refused = new Map(); // model id -> content error, for this chunk only
    let rejectedStatus = 0; // key rejection seen during this call
    for (;;) {
      const t = now();
      const liveKeys = keys.filter((key) => keyUntil(key) <= t);
      if (!liveKeys.length) {
        const earliest = Math.min(...keys.map(keyUntil));
        throw blocked(rejectedStatus ? 'gemini blocked: HTTP ' + rejectedStatus : 'gemini disabled', earliest - t, rejectedStatus || undefined);
      }
      const usable = []; // best model first, keys in order inside a model
      for (const model of models) {
        if (refused.has(model.id) || state.models[model.id].until > t) continue;
        if (isGemma(model.id) && String(text).length > GEMMA_CHUNK_MAX) {
          refused.set(model.id, makeContent('text too long for ' + model.id));
          continue;
        }
        for (const key of liveKeys) {
          if (pairOf(key, model).until <= t) usable.push({ model, key });
        }
      }
      if (!usable.length) {
        if (refused.size) throw [...refused.values()].at(-1);
        const earliest = Math.min(...models.flatMap((model) => liveKeys.map((key) => Math.max(state.models[model.id].until, pairOf(key, model).until))));
        throw blocked('gemini: every model is cooling down or exhausted', earliest - t);
      }
      const wait = (entry) => Math.max(0, pairOf(entry.key, entry.model).nextAt - t);
      const minWait = (list) => list.reduce((a, b) => (wait(b) < wait(a) ? b : a));
      const bestModel = usable[0].model;
      const bestPairs = usable.filter((entry) => entry.model === bestModel);
      const ready = usable.find((entry) => wait(entry) === 0);
      const bestWaiter = minWait(bestPairs);
      if (!ready || (ready.model !== bestModel && wait(bestWaiter) < PREFER_WAIT_MS)) {
        const target = ready ? bestWaiter : minWait(usable);
        if (wait(target) > MAX_SPACING_WAIT_MS) throw blocked('gemini: rate spacing', wait(target));
        await sleep(wait(target));
        continue;
      }

      const { model, key } = ready;
      pairOf(key, model).nextAt = t + spacingMs(model, text);
      const body = buildBody(model);
      let response;
      try {
        response = await fetchImpl(base + encodeURIComponent(model.id) + ':generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key.value },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        // Timeout or network failure; the message may carry the URL, so only the error name is logged.
        parkTransient(key, model, (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : 'network error'));
        continue;
      }

      if (response.ok) {
        let json;
        try { json = JSON.parse(await response.text()); } catch { throw new Error('gemini response is not JSON'); }
        try {
          const out = parse(json);
          pairOf(key, model).transientFails = 0;
          meta.model = model.id;
          meta.key = key.name;
          return out;
        } catch (error) {
          if (!isContentError(error)) throw error;
          refused.set(model.id, error); // this model refused the text: try the next one
          continue;
        }
      }

      const raw = response.status === 429 || response.status === 400 || response.status === 404
        ? await response.text().catch(() => '') : '';
      if (response.status === 401 || response.status === 403 || (response.status === 400 && /API[ _]KEY[ _](NOT[ _]VALID|INVALID)/i.test(raw))) {
        const entry = state.keys[key.fingerprint];
        entry.until = now() + maxCooldownMs;
        rejectedStatus = response.status;
        if (entry.announcedUntil !== entry.until) {
          entry.announcedUntil = entry.until;
          warn('[worker] gemini ' + key.label + ' disabled: key rejected (HTTP ' + response.status + ') until ' + new Date(entry.until).toISOString());
          if (keys.every((k) => keyUntil(k) > now())) warn('[worker] gemini: no usable API key (every key rejected), provider off until ' + new Date(Math.min(...keys.map(keyUntil))).toISOString());
        }
        continue;
      }
      if (response.status === 429) {
        const { daily, delayMs } = classifyQuotaError(raw);
        if (daily) parkPair(key, model, nextPacificMidnight(now()), 'exhausted');
        else parkPair(key, model, now() + clampDelay(delayMs ?? UNKNOWN_429_COOLDOWN_MS), 'rate limited');
        continue;
      }
      if (response.status === 404 || (response.status === 400 && /not found|not supported|unsupported|not enabled|is not a valid model/i.test(raw))) {
        parkModel(model, now() + maxCooldownMs, 'unavailable (HTTP ' + response.status + ')');
        continue;
      }
      if (response.status >= 500 && response.status <= 599) {
        parkTransient(key, model, 'overloaded (HTTP ' + response.status + ')');
        continue;
      }
      const error = new Error('gemini HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
  };
}

