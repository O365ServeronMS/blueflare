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
 * Order of attempts: the opencode sidecar x its models, then OpenRouter x its models (see
 * config.js roleRoutes); inside a model, keys in order. A pair moves aside on 401/402,
 * 408/429/5xx (after AI_RETRIES tries), network error, timeout, empty answer, broken JSON,
 * schema failure, or an image it cannot read. OpenRouter-only body fields (usage, reasoning)
 * and headers go to OpenRouter only. opencode (basic auth) gets one stateless generation from a
 * session of the stock `plan` agent (`POST /api/session/{id}/generate`; one session per model,
 * created on first use and again when it is gone): the messages are flattened into its single
 * prompt, JSON is asked for in that prompt, and its answer/error is mapped back onto the
 * chat-completions shape the loop below reads (see opencodeResponse). opencode Zen serves its free
 * models only to requests of a stock opencode agent: `/api/experimental/generate/text` (no agent)
 * or an agent with changed permissions gets "Free usage limit reached". Keys travel only in the Authorization
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
// opencode's free allowance is spent ("Free usage limit reached", shared by every free model of
// the account), until `retryAfterMs` when opencode states it.
const FREE_ALLOWANCE_DONE = /free usage limit reached/i;
// The stock opencode agent whose sessions generate; read-only, and generate runs no tools.
export const OPENCODE_AGENT = 'plan';
const OPENCODE_SESSION_TITLE = 'blueflare-ai';
const MAX_ALLOWANCE_PARK_MS = 2 * 24 * 60 * 60 * 1000;

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

/**
 * opencode session generate takes one prompt: system text first, then the conversation. A single
 * user turn goes in as is; several turns are labelled by role.
 */
export function flattenMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).filter(Boolean);
  const turns = messages.filter((m) => m.role !== 'system');
  const body = turns.length === 1
    ? [contentText(turns[0].content)]
    : turns.map((m) => String(m.role).toUpperCase() + ':\n' + contentText(m.content));
  return [...system, ...body].filter(Boolean).join('\n\n');
}

/** `opencode/big-pickle` -> { providerID: 'opencode', id: 'big-pickle' }. */
const opencodeModel = (id) => {
  const slash = id.indexOf('/');
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1) };
};

// opencode ProviderRequestError.reason -> the HTTP status the loop already knows how to handle.
const OPENCODE_REASON_STATUS = Object.freeze({ authentication: 401, rate_limit: 429, content_filter: 403, invalid_request: 400, overloaded: 503, provider: 502 });

/**
 * Map an opencode answer onto { status, json, headers } of a chat completion. Success
 * `{data:{text, tokens, cost}}` becomes one choice with usage (cached prompt tokens count as
 * prompt). ServiceUnavailableError (HTTP 503) "Free usage limit reached" becomes a 429 and
 * "Model unavailable" a 404; ProviderRequestError (HTTP 502) takes the status of its `reason`
 * and turns `retryAfterMs` into a Retry-After header; other errors keep their status.
 */
export function opencodeResponse(status, json) {
  if (status < 400) {
    const data = json?.data;
    const text = typeof data?.text === 'string' ? data.text : null;
    if (text == null) return { status, json: null, headers: null };
    const t = data.tokens;
    const usage = t && typeof t === 'object' ? {
      prompt_tokens: (Number(t.input) || 0) + (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0),
      completion_tokens: Number(t.output) || 0,
      completion_tokens_details: { reasoning_tokens: Number(t.reasoning) || 0 },
      cost: Number.isFinite(Number(data.cost)) ? Number(data.cost) : null
    } : undefined;
    return { status, json: { choices: [{ message: { content: text }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }, headers: null };
  }
  let mapped = status;
  const headers = {};
  const message = String(json?.message ?? '');
  if (json?._tag === 'ServiceUnavailableError' && FREE_ALLOWANCE_DONE.test(message)) mapped = 429;
  else if (json?._tag === 'ServiceUnavailableError' && /model unavailable/i.test(message)) mapped = 404;
  else if (json?._tag === 'ProviderRequestError') {
    mapped = OPENCODE_REASON_STATUS[json.reason] ?? (Number(json.status) >= 400 ? Number(json.status) : 502);
    const retry = Number(json.retryAfterMs);
    if (Number.isFinite(retry) && retry > 0) headers['retry-after'] = String(Math.ceil(retry / 1000));
  }
  return { status: mapped, json, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null } };
}

/** Transport for AI_FAKE=1 and tests: JSON calls get `{"fake":true}`, text calls echo the last user message. */
export function fakeTransport() {
  return async (url, init = {}) => {
    const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (!init.body) return reply(200, { data: [] });
    const body = JSON.parse(init.body);
    if (/\/api\/session$/.test(url)) return reply(200, { data: { id: 'ses_fake' } }); // opencode session
    if (typeof body.prompt === 'string') { // opencode session generate
      const content = body.prompt.includes(JSON_INSTRUCTION) ? '{"fake":true}' : 'fake: ' + body.prompt.slice(-200);
      return reply(200, { data: { text: content } });
    }
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

  // opencode session per key+model: generate is stateless, so one session serves every call.
  const ocSessions = new Map();
  /**
   * One opencode generation: make (or reuse) the model's session, then generate. A session that
   * is gone (404, e.g. the sidecar's store was reset) is made again once. Returns the fetch
   * response of the step that ended it, so a failed session creation is handled like any answer.
   */
  async function opencodeFetch(provider, key, model, prompt, signal) {
    const send = transport ?? globalThis.fetch;
    const post = (path, body) => send(provider.baseUrl + path, { method: 'POST', headers: headersFor(provider, key), body: JSON.stringify(body), signal });
    const slot = key.name + ' ' + model.id;
    for (let fresh = 0; fresh < 2; fresh++) {
      let id = ocSessions.get(slot);
      if (!id) {
        const created = await post('/api/session', { title: OPENCODE_SESSION_TITLE, agent: OPENCODE_AGENT, model: opencodeModel(model.id) });
        if (!created.ok) return created;
        const raw = await created.text().catch(() => '');
        try { id = JSON.parse(raw)?.data?.id; } catch { id = null; }
        if (typeof id !== 'string' || !id) return { ok: false, status: 502, headers: created.headers, text: async () => raw };
        ocSessions.set(slot, id);
      }
      const response = await post('/api/session/' + encodeURIComponent(id) + '/generate', { prompt });
      if (response.status !== 404 || fresh) return response;
      const raw = await response.text().catch(() => '');
      if (!/SessionNotFound/.test(raw)) return { ok: false, status: 404, headers: response.headers, text: async () => raw };
      ocSessions.delete(slot);
    }
    throw new Error('unreachable');
  }

  function headersFor(provider, key) {
    if (provider.kind === 'opencode') {
      return { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + key.value).toString('base64') };
    }
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
          if (refused.has(mid) || (images && (state.noVision.has(mid) || route.provider.kind === 'opencode'))) continue;
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
      // opencode has no response_format: JSON is always asked for in the prompt.
      const formatIndex = mode === 'json' ? (provider.kind === 'opencode' ? FORMATS.length - 1 : Math.max(opts.schema ? 0 : 1, state.formats.get(mid) ?? 0)) : -1;
      const format = formatIndex >= 0 ? FORMATS[formatIndex] : null;
      const chatBody = requestBody(provider, model, messages, opts, format, opts.schema, maxTokens);
      const isOpencode = provider.kind === 'opencode';
      const body = chatBody;
      const handle = ledger ? await ledger.begin(ledgerId(key, role), model.id, est, t) : null;
      const started = now();

      // ---- one HTTP attempt -> outcome ------------------------------------------------------
      let status = 0;
      let raw = '';
      let json = null;
      let headers = null;
      let networkReason = null;
      try {
        const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal]) : AbortSignal.timeout(timeoutMs);
        const response = isOpencode
          ? await opencodeFetch(provider, key, model, flattenMessages(chatBody.messages), signal)
          : await (transport ?? globalThis.fetch)(provider.baseUrl + '/chat/completions', { method: 'POST', headers: headersFor(provider, key), body: JSON.stringify(body), signal });
        status = response.status;
        headers = response.headers;
        raw = await response.text().catch(() => '');
        try { json = JSON.parse(raw); } catch { /* checked below */ }
        if (isOpencode) ({ status, json, headers } = opencodeResponse(status, json));
        // A provider failure can come as HTTP 200 with {error:{code,message}}.
        else if (response.ok && json?.error) status = Number(json.error.code) >= 400 ? Number(json.error.code) : 502;
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
      } else if (status === 429 && isOpencode && FREE_ALLOWANCE_DONE.test(raw)) {
        // Nothing works before the reset, on any opencode model: park the key until retryAfterMs,
        // or for AI_COOLDOWN_MS when opencode states no time (session generate does not).
        const retryAfter = Number(headers?.get?.('retry-after'));
        const stated = retryAfter > 0 ? retryAfter * 1000 : NaN;
        const wait = Number.isFinite(stated) ? Math.min(Math.max(stated, 60000), MAX_ALLOWANCE_PARK_MS) : cfg.cooldownMs;
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
