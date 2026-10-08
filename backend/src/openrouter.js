import { createHash } from 'node:crypto';
import { parseApiKeys } from './config.js';
import { utcDay, nextUtcMidnight } from './aiQuotaLedger.js';

export { utcDay, nextUtcMidnight };

/** Non-reversible short id of a key for logs: first 6 hex of sha256. Never any part of the key itself. */
export function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 6);
}

/**
 * OpenRouter (OpenAI-compatible /chat/completions) rotation shared by review translation and the
 * TMDB AI match. Call contract: `call({ text, tokens, buildBody(model), parse(json), meta })`,
 * `call.ready()`, so both consumers only differ in prompt and parser.
 *
 *  - Limits belong to the account, not to a (key, model) pair: free models are ~20 req/min and
 *    1000 req/day (after a one-off 10 USD top-up); paid models have no daily cap. A daily 429 on a
 *    `:free` model therefore parks every `:free` model of that key until the reset (00:00 UTC).
 *  - Models are tried in the configured order; the next one answers when a model is parked.
 *  - Spend on paid models is bounded by `paidDailyOutputCap` (completion tokens per UTC day, summed
 *    over the non-`:free` models through the persistent ledger); `:free` models keep serving after it.
 *  - A provider failure can arrive as HTTP 200 with an `error` object; it is handled like its status.
 *  - Keys travel only in the Authorization header and never reach a URL, error or log.
 */

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const FREE_RPM = 20;
const SPACING_MARGIN_MS = 250;
const MAX_SPACING_WAIT_MS = 30000;
const UNKNOWN_429_COOLDOWN_MS = 60000;
const DAILY_RETRY_DELAY_MS = 10 * 60 * 1000;
const TRANSIENT_PARK_MS = 45000;
const TRANSIENT_PARK_MAX_MS = 5 * 60 * 1000;

const isFree = (id) => /:free$/.test(id);

/** OPENROUTER_*_MODELS: ordered `id[:rpm[:rpd]]` (the id itself may end in `:free`). rpm 0 = no spacing. */
export function parseOpenRouterModels(value) {
  const seen = new Set();
  const out = [];
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  for (const raw of entries) {
    const text = (typeof raw === 'string' ? raw : `${raw.id}:${raw.rpm ?? ''}:${raw.rpd ?? ''}`).trim();
    if (!text) continue;
    // `vendor/model[:free][:rpm[:rpd]]`: numeric trailing parts are limits, `free` belongs to the id.
    const parts = text.split(':');
    const id = [parts.shift()];
    while (parts.length && !/^\d+$/.test(parts[0])) id.push(parts.shift());
    const modelId = id.join(':').trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const rpm = Number(parts[0]);
    const entry = { id: modelId, rpm: parts[0] !== undefined && Number.isFinite(rpm) && rpm >= 0 ? rpm : (isFree(modelId) ? FREE_RPM : 0) };
    const rpd = Number(parts[1]);
    if (parts[1] && Number.isFinite(rpd) && rpd > 0) entry.rpd = rpd;
    out.push(entry);
  }
  return out;
}

/** Quota-ledger id of a key for one purpose: the two jobs never share counters even on one key. */
export const scopedFingerprint = (key, scope) => createHash('sha256').update(String(scope) + ':' + String(key)).digest('hex').slice(0, 12);

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

/** Token counts of a chat completion, in the shape both consumers already read. */
export function usageOf(json) {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const promptTokens = num(u.prompt_tokens);
  const outputTokens = num(u.completion_tokens);
  const thoughtTokens = num(u.completion_tokens_details?.reasoning_tokens);
  const totalTokens = num(u.total_tokens) ?? (promptTokens != null ? promptTokens + (outputTokens ?? 0) : null);
  return { promptTokens, outputTokens, thoughtTokens, totalTokens };
}

/**
 * Text of choices[0], or throws via `makeError`: filtered content and truncation are per-text
 * refusals (the next model gets the text), an empty answer is a retryable plain Error.
 */
export function chatText(json, makeError = (message) => Object.assign(new Error(message), { permanent: true })) {
  const choice = json?.choices?.[0];
  if (!choice) throw new Error('openrouter response has no choice');
  if (choice.finish_reason === 'content_filter') throw makeError('openrouter refused content: content_filter');
  if (choice.finish_reason === 'length') throw makeError('openrouter output truncated');
  const content = choice.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!clean) throw new Error('openrouter returned no text');
  return clean;
}

export function createOpenRouterRotation(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKeys = parseApiKeys(options.apiKeys);
  const models = parseOpenRouterModels(options.models);
  const scope = options.scope ?? 'openrouter';
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxCooldownMs = options.cooldownMs ?? 6 * 60 * 60 * 1000;
  const endpoint = (options.baseUrl ?? OPENROUTER_BASE).replace(/\/+$/, '') + '/chat/completions';
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const warn = options.warn ?? ((message) => console.warn(message));
  const makeBlocked = options.blockedError ?? ((message) => Object.assign(new Error(message), { blocked: true }));
  const makeContent = options.contentError ?? ((message) => Object.assign(new Error(message), { permanent: true }));
  const isContentError = options.isContentError ?? ((error) => error?.permanent === true);
  const transientBaseMs = options.transientParkMs ?? TRANSIENT_PARK_MS;
  const transientMaxMs = options.transientParkMaxMs ?? TRANSIENT_PARK_MAX_MS;
  const ledger = options.ledger ?? null;
  const paidCap = Number(options.paidDailyOutputCap) > 0 ? Number(options.paidDailyOutputCap) : null;
  const state = options.state ?? {};
  state.models ??= {};
  state.keys ??= {};
  state.pairs ??= {};
  if (!models.length) throw new Error((options.modelsName ?? 'OPENROUTER_MODELS') + ' is empty');
  if (!apiKeys.length) throw new Error('no OpenRouter API key');
  for (const model of models) state.models[model.id] ??= { until: 0, announcedUntil: 0 };
  const keys = apiKeys.map((value, index) => {
    const fingerprint = keyFingerprint(value);
    state.keys[fingerprint] ??= { until: 0, announcedUntil: 0 };
    return { value, fingerprint, ledgerId: scopedFingerprint(value, scope), name: 'k' + (index + 1), label: 'k' + (index + 1) + ' (' + fingerprint + ')' };
  });
  const pairOf = (key, model) => (state.pairs[key.fingerprint + '|' + model.id] ??= { until: 0, nextAt: 0, announcedUntil: 0, transientFails: 0 });
  const keyUntil = (key) => state.keys[key.fingerprint].until;
  const clampDelay = (ms) => Math.min(Math.max(ms, 1000), maxCooldownMs);
  const blocked = (message, retryAfterMs, status) => {
    const error = makeBlocked(message);
    error.retryAfterMs = clampDelay(retryAfterMs);
    if (status) error.status = status;
    return error;
  };

  /** Output (completion) tokens produced today by models that are not `:free`, summed over all of them. */
  const paidTokensToday = (t) => {
    if (!ledger) return 0;
    let used = 0;
    for (const key of keys) for (const model of models) if (!isFree(model.id)) used += ledger.snapshot(key.ledgerId, model.id, t).outputTokens;
    return used;
  };
  const paidCapReached = (t) => paidCap != null && paidTokensToday(t) >= paidCap;

  const parkPair = (key, model, until, reason) => {
    const pair = pairOf(key, model);
    pair.until = until;
    if (pair.announcedUntil !== until) {
      pair.announcedUntil = until;
      warn('[worker] openrouter ' + key.label + ' model ' + model.id + ' ' + reason + ' until ' + new Date(until).toISOString());
    }
  };
  const parkModel = (model, until, reason) => {
    const entry = state.models[model.id];
    entry.until = until;
    if (entry.announcedUntil !== until) {
      entry.announcedUntil = until;
      warn('[worker] openrouter model ' + model.id + ' ' + reason + ' until ' + new Date(until).toISOString());
    }
  };
  const parkTransient = (key, model, reason) => {
    const pair = pairOf(key, model);
    pair.transientFails += 1;
    parkPair(key, model, now() + Math.min(transientBaseMs * 2 ** (pair.transientFails - 1), transientMaxMs, maxCooldownMs), reason);
  };

  async function call({ text, tokens, buildBody, parse, meta = {} }) {
    const refused = new Map(); // model id -> content error, for this call only
    let rejectedStatus = 0;
    await ledger?.ready();
    const estTokens = tokens ?? Math.ceil(String(text).length / 3) + 300;
    for (;;) {
      const t = now();
      const liveKeys = keys.filter((key) => keyUntil(key) <= t);
      if (!liveKeys.length) {
        const earliest = Math.min(...keys.map(keyUntil));
        throw blocked(rejectedStatus ? 'openrouter blocked: HTTP ' + rejectedStatus : 'openrouter disabled', earliest - t, rejectedStatus || undefined);
      }
      const usable = []; // best model first, keys in order inside a model
      const eligibleAt = [];
      const paidSpent = paidCapReached(t); // paid models sit out for the rest of the UTC day; `:free` ones carry on
      for (const model of models) {
        if (refused.has(model.id)) continue;
        if (paidSpent && !isFree(model.id)) { eligibleAt.push(nextUtcMidnight(t)); continue; }
        for (const key of liveKeys) {
          const check = ledger
            ? ledger.availability(key.ledgerId, model.id, { rpm: model.rpm || null, rpd: model.rpd ?? null, tpm: null }, t, estTokens)
            : { ok: true, rpmAt: 0 };
          const at = Math.max(state.models[model.id].until, pairOf(key, model).until, check.ok ? 0 : check.until);
          if (at <= t) usable.push({ model, key, rpmAt: check.rpmAt ?? 0 });
          else eligibleAt.push(at);
        }
      }
      if (!usable.length) {
        if (refused.size) throw [...refused.values()].at(-1);
        throw blocked('openrouter: every model is cooling down or exhausted', Math.min(...eligibleAt) - t);
      }
      const wait = (entry) => Math.max(0, Math.max(pairOf(entry.key, entry.model).nextAt, entry.rpmAt) - t);
      const ready = usable.find((entry) => wait(entry) === 0);
      if (!ready) {
        const target = usable.reduce((a, b) => (wait(b) < wait(a) ? b : a));
        if (wait(target) > MAX_SPACING_WAIT_MS) throw blocked('openrouter: rate spacing', wait(target));
        await sleep(wait(target));
        continue;
      }

      const { model, key } = ready;
      if (model.rpm) pairOf(key, model).nextAt = t + Math.ceil(60000 / model.rpm) + SPACING_MARGIN_MS;
      const handle = ledger ? await ledger.begin(key.ledgerId, model.id, estTokens, t) : null;
      const settle = async (ok, usage) => { if (ledger) await ledger.finish(handle, { ok, tokens: usage?.promptTokens ?? null, totalTokens: usage?.totalTokens ?? null, outputTokens: usage?.outputTokens ?? (usage?.totalTokens != null && usage?.promptTokens != null ? usage.totalTokens - usage.promptTokens : null) }); };
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + key.value,
            'http-referer': 'https://phim.bluesia.net',
            'x-title': 'FilmBluesia'
          },
          body: JSON.stringify({ model: model.id, ...buildBody(model) }),
          signal: options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        await settle(false);
        if (options.signal?.aborted) throw blocked('openrouter: stopping', 1000);
        parkTransient(key, model, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : 'network error');
        continue;
      }

      const raw = await response.text().catch(() => '');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* checked below */ }
      // A provider failure can come as HTTP 200 with {error:{code,message}}.
      let status = response.status;
      if (response.ok && json?.error) status = Number(json.error.code) >= 400 ? Number(json.error.code) : 502;
      if (response.ok && status === response.status && !json) {
        await settle(false);
        throw new Error('openrouter response is not JSON');
      }

      if (status < 400) {
        const usage = usageOf(json);
        meta.usage = usage;
        await settle(true, usage);
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

      await settle(false);
      if (status === 401) {
        const entry = state.keys[key.fingerprint];
        entry.until = now() + maxCooldownMs;
        rejectedStatus = status;
        if (entry.announcedUntil !== entry.until) {
          entry.announcedUntil = entry.until;
          warn('[worker] openrouter ' + key.label + ' disabled: key rejected (HTTP 401) until ' + new Date(entry.until).toISOString());
        }
        continue;
      }
      if (status === 402 || (status === 403 && /key limit exceeded/i.test(raw))) { // out of credit / key spend limit: later models (e.g. :free) may still answer
        parkModel(model, now() + maxCooldownMs, status === 402 ? 'needs credit (HTTP 402)' : 'key spend limit reached (HTTP 403)');
        continue;
      }
      if (status === 403) { // input flagged by the provider's moderation
        refused.set(model.id, makeContent('openrouter refused content: HTTP 403'));
        continue;
      }
      if (status === 429) {
        const { daily, delayMs } = classifyRateLimit(raw, response.headers, now());
        if (daily && isFree(model.id)) {
          const until = delayMs != null ? now() + delayMs : nextUtcMidnight(now());
          for (const other of models) if (isFree(other.id)) parkPair(key, other, until, 'free-tier daily limit reached');
        } else parkPair(key, model, now() + clampDelay(delayMs ?? UNKNOWN_429_COOLDOWN_MS), 'rate limited');
        continue;
      }
      if (status === 404 || (status === 400 && /not a valid model|no endpoints|not supported|unsupported/i.test(raw))) {
        parkModel(model, now() + maxCooldownMs, 'unavailable (HTTP ' + status + ')');
        continue;
      }
      if (status === 408 || status >= 500) {
        parkTransient(key, model, 'overloaded (HTTP ' + status + ')');
        continue;
      }
      const error = new Error('openrouter HTTP ' + status);
      error.status = status;
      throw error;
    }
  }

  call.ready = async () => { await ledger?.ready(); };
  call.paidTokensToday = (t = now()) => paidTokensToday(t);
  return call;
}
