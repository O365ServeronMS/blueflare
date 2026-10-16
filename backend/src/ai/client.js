import { readAiConfig, getRole, roleRoutes, roleTimeoutMs, rolePaidCap, roleReasoning } from './config.js';
import {
  checkSchema, classifyRateLimit, contentText, extractJson, isFree, keyFingerprint, nextUtcMidnight, scopedFingerprint,
  sniffImageType, usageOf
} from './util.js';

/**
 * The AI engine. Every module that needs a model calls `chat(role, messages, options)` or
 * `json(role, messages, options)`; HTTP, keys, model order, fallback, retries, quota and
 * response_format negotiation all live here.
 *
 * Order of attempts: primary provider x its models, then OpenRouter x its models (see
 * config.js roleRoutes); inside a model, keys in order. A pair moves aside on 401/402,
 * 408/429/5xx (after AI_RETRIES tries), network error, timeout, empty answer, broken JSON,
 * schema failure, or an image it cannot read. OpenRouter-only body fields (usage, reasoning)
 * and headers are never sent to the primary provider. Keys travel only in the Authorization
 * header: never in a URL, error, attempt or log line.
 */

const FORMATS = ['json_schema', 'json_object', 'none'];
const SPACING_MARGIN_MS = 250;
const MAX_SPACING_WAIT_MS = 30000;
const UNKNOWN_429_COOLDOWN_MS = 60000;
const MAX_RETRY_DELAY_MS = 10000;
const RETRY_BASE_MS = 500;
const JSON_INSTRUCTION = 'Answer with a single valid JSON value only: no markdown, no code fences, no commentary.';
const MODEL_GONE = /not a valid model|no endpoints|model[^.]{0,40}(not found|does not exist|not exist|unknown)|unknown model|not supported|unsupported model/i;
const PARAMS_REJECTED = /requested parameters|response_format|json_schema|json_object|structured output/i;
const IMAGE_REJECTED = /image|vision|multimodal|modalit/i;
// Token Harbor: the whole free allowance of the key is spent until a stated date, for every model.
const FREE_ALLOWANCE_DONE = /free_tier_limit_reached|used this period.s free allowance/i;
const ALLOWANCE_RESET = /starts on (\d{1,2} [A-Za-z]{3,9} \d{4}) at (\d{1,2}:\d{2}) UTC/i;
const MAX_ALLOWANCE_PARK_MS = 8 * 24 * 60 * 60 * 1000;
const AUTH_LOCKOUT = /failed authenticat|authentication attempts|invalid (api )?key|api key (is )?(invalid|revoked)/i;

/** The only error the AI module throws for a failed call. `attempts`: [{ provider, model, reason }]. */
export class AiError extends Error {
  constructor(message, { kind = 'failed', attempts = [], retryAfterMs = null, role = null } = {}) {
    super(message);
    this.name = 'AiError';
    /** 'content': every model refused or mangled this input; 'unavailable': quota/outage, retry after `retryAfterMs`; 'failed': anything else. */
    this.kind = kind;
    this.role = role;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
    this.blocked = kind === 'unavailable';
    this.permanent = kind === 'content';
  }
}

/** Content part for an image: `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }`. */
export function imagePart(bytes, mime) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const type = mime ?? sniffImageType(buffer);
  if (!type) throw new TypeError('imagePart: unknown image type, pass the MIME type');
  return { type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + buffer.toString('base64') } };
}

const hasImages = (messages) => messages.some((m) => Array.isArray(m?.content) && m.content.some((part) => part?.type === 'image_url'));

/** `reasoning` option -> OpenRouter body field. 'off' | 'low' | 'medium' | 'high' | { maxTokens }. */
function reasoningField(reasoning) {
  if (reasoning == null) return undefined;
  if (reasoning === 'off') return { enabled: false };
  if (['low', 'medium', 'high'].includes(reasoning)) return { effort: reasoning };
  if (typeof reasoning === 'object' && Number.isFinite(Number(reasoning.maxTokens))) {
    const n = Math.floor(Number(reasoning.maxTokens));
    return n > 0 ? { max_tokens: n } : { enabled: false };
  }
  throw new TypeError("reasoning must be 'off', 'low', 'medium', 'high' or { maxTokens }");
}

/** Rough prompt size in tokens from the text parts (images are not counted). */
const estimateTokens = (messages) => Math.ceil(messages.reduce((sum, m) => sum + contentText(m.content).length, 0) / 3) + 300;

/** Transport for AI_FAKE=1 and tests: JSON calls get `{"fake":true}`, text calls echo the last user message. */
export function fakeTransport() {
  return async (url, init = {}) => {
    const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (!init.body) return reply(200, { data: [] });
    const body = JSON.parse(init.body);
    const wantsJson = Boolean(body.response_format) || body.messages.some((m) => m.role === 'system' && contentText(m.content).includes(JSON_INSTRUCTION));
    const user = [...body.messages].reverse().find((m) => m.role === 'user');
    const content = wantsJson ? '{"fake":true}' : 'fake: ' + contentText(user?.content).slice(0, 200);
    return reply(200, { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  };
}

const FAKE_ROUTE = Object.freeze({ provider: { name: 'fake', baseUrl: 'http://fake.invalid', keys: ['fake'], openrouter: false }, models: [{ id: 'fake', rpm: 0 }] });

/**
 * Options: `config` (readAiConfig result) or `env`; `transport` (fetch-like); `ledger`
 * (aiQuotaLedger, the one place quota and the paid-output cap are checked); `onCall`;
 * `now`, `sleep`, `warn`, `retryBaseMs`.
 */
export function createAi(options = {}) {
  const warn = options.warn ?? ((message) => console.warn(message));
  const cfg = options.config ?? readAiConfig(options.env ?? process.env, { warn });
  let transport = options.transport ?? (cfg.fake ? fakeTransport() : null);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const ledger = options.ledger ?? null;
  const listeners = new Set(options.onCall ? [options.onCall] : []);
  const state = { keys: new Map(), models: new Map(), pairs: new Map(), formats: new Map(), noVision: new Set(), catalogs: new Map() };
  const keyCache = new Map();

  const routesFor = (role) => {
    const routes = roleRoutes(cfg, role.name);
    return routes.length || !cfg.fake ? routes : [FAKE_ROUTE];
  };
  const keysOf = (provider) => {
    let keys = keyCache.get(provider.name);
    if (!keys) {
      keys = provider.keys.map((value, index) => {
        const fingerprint = keyFingerprint(value);
        return { value, fingerprint, name: 'k' + (index + 1), label: provider.name + ' k' + (index + 1) + ' (' + fingerprint + ')' };
      });
      keyCache.set(provider.name, keys);
    }
    return keys;
  };
  const entry = (map, id, init) => {
    let value = map.get(id);
    if (!value) map.set(id, (value = init()));
    return value;
  };
  const keyState = (key) => entry(state.keys, key.fingerprint, () => ({ until: 0, announcedUntil: 0 }));
  const modelState = (mid) => entry(state.models, mid, () => ({ until: 0, announcedUntil: 0 }));
  const pairState = (pid) => entry(state.pairs, pid, () => ({ until: 0, nextAt: 0, announcedUntil: 0, transientFails: 0 }));
  const clamp = (ms) => Math.min(Math.max(ms, 1000), cfg.cooldownMs);
  const until = (iso) => new Date(iso).toISOString();
  const announce = (slot, at, message) => {
    slot.until = at;
    if (slot.announcedUntil !== at) {
      slot.announcedUntil = at;
      warn('[ai] ' + message + ' until ' + until(at));
    }
  };
  const ledgerId = (key, role) => scopedFingerprint(key.value, role.ledgerScope);

  /** Completion tokens of non-`:free` models today, over every route and key of the role. */
  const paidTokensToday = (roleName, t = now()) => {
    if (!ledger) return 0;
    const role = getRole(roleName);
    let used = 0;
    for (const route of routesFor(role)) {
      for (const key of keysOf(route.provider)) {
        for (const model of route.models) if (!isFree(model.id)) used += ledger.snapshot(ledgerId(key, role), model.id, t).outputTokens;
      }
    }
    return used;
  };

  /** OpenRouter's catalog says which models take images; fetched once per provider, a failure is ignored. */
  const loadCatalog = async (provider) => {
    if (!provider.openrouter || state.catalogs.has(provider.name)) return;
    state.catalogs.set(provider.name, true);
    try {
      const response = await (transport ?? globalThis.fetch)(provider.baseUrl + '/models', {
        method: 'GET', headers: { authorization: 'Bearer ' + keysOf(provider)[0].value }, signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) return;
      const json = JSON.parse(await response.text());
      for (const model of Array.isArray(json?.data) ? json.data : []) {
        const inputs = model?.architecture?.input_modalities;
        if (typeof model?.id === 'string' && Array.isArray(inputs) && !inputs.includes('image')) state.noVision.add(provider.name + '|' + model.id);
      }
    } catch { /* unknown capability: the model will say so with a 400 */ }
  };

  const emit = (record) => {
    for (const listener of listeners) {
      try { listener(record); } catch (error) { warn('[ai] onCall listener failed: ' + String(error?.message).slice(0, 120)); }
    }
  };

  function requestBody(provider, model, messages, opts, format, schema, maxTokens) {
    let msgs = messages;
    if (format) {
      const instruction = JSON_INSTRUCTION + (format === 'none' && schema ? '\nThe JSON must match this JSON schema: ' + JSON.stringify(schema) : '');
      msgs = messages[0]?.role === 'system' && typeof messages[0].content === 'string'
        ? [{ ...messages[0], content: messages[0].content + '\n\n' + instruction }, ...messages.slice(1)]
        : [{ role: 'system', content: instruction }, ...messages];
    }
    const body = { model: model.id, messages: msgs, temperature: opts.temperature ?? 0, max_tokens: maxTokens };
    if (format === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema } };
    if (format === 'json_object') body.response_format = { type: 'json_object' };
    if (provider.openrouter) {
      body.usage = { include: true };
      const reasoning = reasoningField(opts.reasoning);
      if (reasoning) body.reasoning = reasoning;
    } else if (['low', 'medium', 'high'].includes(opts.reasoning)) {
      body.reasoning_effort = opts.reasoning; // OpenAI-style field; providers that do not know it ignore it
    }
    return body;
  }

  function headersFor(provider, key) {
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key.value };
    if (provider.openrouter) {
      headers['http-referer'] = 'https://phim.bluesia.net';
      headers['x-title'] = 'FilmBluesia';
    }
    return headers;
  }

  async function run(roleName, messages, opts, mode) {
    const role = getRole(roleName);
    if (!Array.isArray(messages) || !messages.length) throw new TypeError('messages must be a non-empty array');
    opts = { ...opts, reasoning: roleReasoning(cfg, role.name) ?? opts.reasoning };
    reasoningField(opts.reasoning); // validate up front
    const images = hasImages(messages);
    if (images && !role.vision) throw new TypeError('AI role ' + role.name + ' does not take images (registerRole with vision: true)');
    let routes = routesFor(role);
    if (opts.only) {
      routes = routes
        .filter((route) => !opts.only.provider || route.provider.name === opts.only.provider)
        .map((route) => ({ ...route, models: route.models.filter((m) => !opts.only.model || m.id === opts.only.model) }))
        .filter((route) => route.models.length);
    }
    if (!routes.length) throw new AiError('ai ' + role.name + ': no provider configured (keys + models)', { kind: 'unavailable', retryAfterMs: cfg.cooldownMs, role: role.name });
    await ledger?.ready();
    if (images) for (const route of routes) await loadCatalog(route.provider);

    const timeoutMs = opts.timeoutMs ?? roleTimeoutMs(cfg, role.name);
    const maxTokens = opts.maxTokens ?? role.maxTokens ?? cfg.maxTokens;
    const est = opts.estTokens ?? estimateTokens(messages);
    const paidCap = rolePaidCap(cfg, role.name);
    const attempts = [];
    const skipped = new Set(); // pairs out of this call only
    const refused = new Set(); // models that refused or mangled this input
    const retried = new Map();
    let contentSeen = false;

    const fail = (kind, retryAfterMs) => {
      const list = attempts.map((a) => a.provider + '/' + a.model + ': ' + a.reason).join('; ') || 'nothing could be tried';
      return new AiError('ai ' + role.name + ' ' + (kind === 'unavailable' ? 'unavailable' : kind === 'content' ? 'refused by every model' : 'failed') + ': ' + list, {
        kind, attempts, retryAfterMs: retryAfterMs == null ? null : clamp(retryAfterMs), role: role.name
      });
    };

    for (;;) {
      if (opts.signal?.aborted) throw fail('unavailable', 1000);
      const t = now();
      const eligibleAt = [];
      let chosen = null;
      let pause = null;
      const paidSpent = paidCap != null && paidTokensToday(role.name, t) >= paidCap; // paid models sit out the UTC day; `:free` ones carry on
      for (const route of routes) {
        const usable = [];
        for (const model of route.models) {
          const mid = route.provider.name + '|' + model.id;
          if (refused.has(mid) || (images && state.noVision.has(mid))) continue;
          if (paidSpent && !isFree(model.id)) { eligibleAt.push(nextUtcMidnight(t)); continue; }
          for (const key of keysOf(route.provider)) {
            const pid = mid + '|' + key.fingerprint;
            if (skipped.has(pid)) continue;
            const check = ledger
              ? ledger.availability(ledgerId(key, role), model.id, { rpm: model.rpm || null, rpd: model.rpd ?? null, tpm: null }, t, est)
              : { ok: true, rpmAt: 0 };
            const at = Math.max(modelState(mid).until, keyState(key).until, pairState(pid).until, check.ok ? 0 : check.until);
            if (at <= t) usable.push({ provider: route.provider, model, key, mid, pid, rpmAt: check.rpmAt ?? 0 });
            else eligibleAt.push(at);
          }
        }
        if (!usable.length) continue;
        const wait = (u) => Math.max(0, Math.max(pairState(u.pid).nextAt, u.rpmAt) - t);
        chosen = usable.find((u) => wait(u) === 0) ?? null;
        if (chosen) break;
        const soonest = Math.min(...usable.map(wait));
        if (soonest <= MAX_SPACING_WAIT_MS) { pause = soonest; break; } // spacing waits on this route, it does not skip it
        eligibleAt.push(t + soonest);
      }
      if (pause != null) { await sleep(pause); continue; }
      if (!chosen) {
        if (contentSeen) throw fail('content');
        if (eligibleAt.length) throw fail('unavailable', Math.min(...eligibleAt) - t);
        throw fail('failed');
      }

      const { provider, model, key, mid, pid } = chosen;
      const pair = pairState(pid);
      if (model.rpm) pair.nextAt = t + Math.ceil(60000 / model.rpm) + SPACING_MARGIN_MS;
      const formatIndex = mode === 'json' ? Math.max(opts.schema ? 0 : 1, state.formats.get(mid) ?? 0) : -1;
      const format = formatIndex >= 0 ? FORMATS[formatIndex] : null;
      const body = requestBody(provider, model, messages, opts, format, opts.schema, maxTokens);
      const handle = ledger ? await ledger.begin(ledgerId(key, role), model.id, est, t) : null;
      const started = now();

      // ---- one HTTP attempt -> outcome ------------------------------------------------------
      let status = 0;
      let raw = '';
      let json = null;
      let headers = null;
      let networkReason = null;
      try {
        const response = await (transport ?? globalThis.fetch)(provider.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: headersFor(provider, key),
          body: JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal]) : AbortSignal.timeout(timeoutMs)
        });
        status = response.status;
        headers = response.headers;
        raw = await response.text().catch(() => '');
        try { json = JSON.parse(raw); } catch { /* checked below */ }
        // A provider failure can come as HTTP 200 with {error:{code,message}}.
        if (response.ok && json?.error) status = Number(json.error.code) >= 400 ? Number(json.error.code) : 502;
      } catch (error) {
        networkReason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network error';
      }
      const usage = status > 0 && status < 400 ? usageOf(json) : null;
      const latencyMs = now() - started;
      let reason = null; // set = this attempt failed
      let result = null;

      if (networkReason) {
        if (opts.signal?.aborted) {
          if (ledger) await ledger.finish(handle, { ok: false });
          attempts.push({ provider: provider.name, model: model.id, reason: 'stopping' });
          throw fail('unavailable', 1000);
        }
        reason = networkReason;
        announce(pair, now() + Math.min(cfg.transientParkMs * 2 ** pair.transientFails++, cfg.transientParkMaxMs, cfg.cooldownMs), provider.name + ' ' + key.name + ' model ' + model.id + ' ' + reason);
      } else if (status < 400) {
        const choice = json?.choices?.[0];
        const text = choice ? contentText(choice.message?.content) : '';
        if (!json) { reason = 'empty or non-JSON body'; skipped.add(pid); }
        else if (choice?.finish_reason === 'content_filter') { reason = 'refused: content_filter'; refused.add(mid); contentSeen = true; }
        else if (choice?.finish_reason === 'length') { reason = 'refused: output truncated'; refused.add(mid); contentSeen = true; }
        else if (!text) { reason = 'empty answer'; skipped.add(pid); }
        else {
          let data;
          if (mode === 'json') {
            const parsed = extractJson(text);
            const problem = parsed.ok ? checkSchema(opts.schema, parsed.value) : 'invalid JSON';
            if (problem) { reason = 'bad JSON: ' + problem; refused.add(mid); contentSeen = true; }
            else data = parsed.value;
          }
          if (!reason) {
            try {
              const value = opts.accept ? await opts.accept(mode === 'json' ? data : text) : (mode === 'json' ? data : text);
              result = { text, data, value, model: model.id, provider: provider.name, key: key.name, format, usage, attempts, latencyMs };
            } catch (error) {
              reason = 'rejected: ' + String(error?.message ?? error).slice(0, 160);
              if (error?.permanent || error?.kind === 'content') { refused.add(mid); contentSeen = true; } else skipped.add(pid);
            }
          }
        }
      } else if (status === 401) {
        reason = 'http 401 (key rejected)';
        announce(keyState(key), now() + cfg.cooldownMs, key.label + ' disabled: key rejected (HTTP 401)');
      } else if (status === 402 || (status === 403 && /key limit exceeded/i.test(raw))) {
        reason = status === 402 ? 'http 402 (needs credit)' : 'http 403 (key spend limit)';
        announce(modelState(mid), now() + cfg.cooldownMs, provider.name + ' model ' + model.id + ' ' + reason);
      } else if (status === 403) {
        reason = 'refused: http 403'; refused.add(mid); contentSeen = true;
      } else if ([400, 404, 422].includes(status) && body.response_format && PARAMS_REJECTED.test(raw)) {
        // e.g. OpenRouter 404 "No endpoints found that can handle the requested parameters".
        reason = 'http ' + status + ' (' + format + ' not supported)';
        state.formats.set(mid, formatIndex + 1);
      } else if ([400, 422].includes(status) && body.response_format && !MODEL_GONE.test(raw) && !(images && IMAGE_REJECTED.test(raw))) {
        reason = 'http ' + status + ' (' + format + ' rejected)';
        state.formats.set(mid, formatIndex + 1);
      } else if (status === 400 && images && IMAGE_REJECTED.test(raw)) {
        reason = 'http 400 (cannot read images)';
        state.noVision.add(mid);
      } else if (status === 404 || (status === 400 && MODEL_GONE.test(raw))) {
        reason = 'http ' + status + ' (model unavailable)';
        announce(modelState(mid), now() + cfg.cooldownMs, provider.name + ' model ' + model.id + ' unavailable (HTTP ' + status + ')');
      } else if (status === 429 && AUTH_LOCKOUT.test(raw)) {
        // Token Harbor: after failed logins the key/IP is locked out (429 + Retry-After). Every
        // model of this key would fail the same way and each try may extend the lockout.
        const { delayMs } = classifyRateLimit(raw, headers, now());
        reason = 'http 429 (auth lockout)';
        announce(keyState(key), now() + clamp(delayMs ?? cfg.cooldownMs), key.label + ' disabled: too many failed authentications (HTTP 429)');
      } else if (status === 429 && FREE_ALLOWANCE_DONE.test(raw)) {
        // Retry-After says 1h, but nothing works before the stated reset: park the key until then.
        const m = ALLOWANCE_RESET.exec(raw);
        const resetAt = m ? Date.parse(m[1] + ' ' + m[2] + ' UTC') : NaN;
        const wait = Number.isFinite(resetAt) ? Math.min(Math.max(resetAt - now(), 60000), MAX_ALLOWANCE_PARK_MS) : cfg.cooldownMs;
        reason = 'http 429 (free allowance used up)';
        announce(keyState(key), now() + wait, key.label + ' free allowance used up (HTTP 429), parked until ' + new Date(now() + wait).toISOString());
      } else if (status === 429) {
        const { daily, delayMs } = classifyRateLimit(raw, headers, now());
        const tries = retried.get(pid) ?? 0;
        reason = 'http 429' + (daily ? ' (daily limit)' : '');
        if (!daily && tries < cfg.retries && (delayMs ?? 0) <= MAX_RETRY_DELAY_MS) {
          retried.set(pid, tries + 1);
          pair.nextAt = Math.max(pair.nextAt, now() + (delayMs ?? retryBaseMs * 2 ** tries));
        } else if (daily && provider.openrouter && isFree(model.id)) {
          // OpenRouter's free-tier day belongs to the account: every `:free` model of this key is done.
          const at = delayMs != null ? now() + delayMs : nextUtcMidnight(now());
          for (const route of routes) {
            if (route.provider !== provider) continue;
            for (const other of route.models) if (isFree(other.id)) announce(pairState(provider.name + '|' + other.id + '|' + key.fingerprint), at, provider.name + ' ' + key.name + ' model ' + other.id + ' free-tier daily limit reached');
          }
        } else {
          const at = daily && delayMs == null ? nextUtcMidnight(now()) : now() + clamp(delayMs ?? UNKNOWN_429_COOLDOWN_MS);
          announce(pair, at, provider.name + ' ' + key.name + ' model ' + model.id + ' rate limited');
        }
      } else if (status === 408 || status >= 500) {
        const tries = retried.get(pid) ?? 0;
        reason = 'http ' + status;
        if (tries < cfg.retries) {
          retried.set(pid, tries + 1);
          pair.nextAt = Math.max(pair.nextAt, now() + retryBaseMs * 2 ** tries);
        } else {
          announce(pair, now() + Math.min(cfg.transientParkMs * 2 ** pair.transientFails++, cfg.transientParkMaxMs, cfg.cooldownMs), provider.name + ' ' + key.name + ' model ' + model.id + ' overloaded (HTTP ' + status + ')');
        }
      } else {
        reason = 'http ' + status;
        skipped.add(pid);
      }

      const completionTokens = usage?.completionTokens ?? (usage?.totalTokens != null && usage?.promptTokens != null ? usage.totalTokens - usage.promptTokens : null);
      if (ledger) await ledger.finish(handle, { ok: status > 0 && status < 400, tokens: usage?.promptTokens ?? null, totalTokens: usage?.totalTokens ?? null, outputTokens: completionTokens });
      emit({
        role: role.name, provider: provider.name, model: model.id, key: key.name, ok: !reason, error: reason, status: status || null, latencyMs,
        promptTokens: usage?.promptTokens ?? null, completionTokens, thoughtTokens: usage?.thoughtTokens ?? null, cost: usage?.cost ?? null
      });
      if (result) {
        pair.transientFails = 0;
        attempts.push({ provider: provider.name, model: model.id, reason: 'ok' });
        return result;
      }
      attempts.push({ provider: provider.name, model: model.id, reason });
    }
  }

  return {
    config: cfg,
    /** Text answer. Options: maxTokens, timeoutMs, temperature (0), reasoning ('off'|'low'|'medium'|'high'|{maxTokens}, OpenRouter only), accept(text) -> value, estTokens, signal, only {provider, model}. */
    chat: (role, messages, opts = {}) => run(role, messages, opts, 'text'),
    /** Parsed JSON answer in `data` (and `value`). Same options plus `schema` (checked; sent as json_schema where supported). */
    json: (role, messages, opts = {}) => run(role, messages, opts, 'json'),
    /** True when the role has at least one provider with keys and models. */
    available: (role) => routesFor(getRole(role)).length > 0,
    /** [{ provider, model }] in the order they would be tried. */
    modelsFor: (role) => routesFor(getRole(role)).flatMap((route) => route.models.map((m) => ({ provider: route.provider.name, model: m.id }))),
    ready: async () => { await ledger?.ready(); },
    paidTokensToday,
    onCall(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setTransport(fn) { transport = fn ?? (cfg.fake ? fakeTransport() : null); }
  };
}
