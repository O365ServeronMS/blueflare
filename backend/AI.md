# AI module

Every model call in the backend goes through `backend/src/ai/`. No other file talks to
an LLM over HTTP, reads AI env variables or implements fallback. Callers today: the TMDB AI match (role `MATCH`,
`tmdbMatchAi.js`) and the weekly catalog audit (role `DEDUPE`, `catalogAudit.js`).

## Calling it

```js
import { getAi, imagePart, AiError } from './ai/index.js';

const ai = getAi(); // process-wide instance; throws AiConfigError on a broken env

// Text
const r = await ai.chat('MATCH', [{ role: 'system', content: 'Answer in one word.' }, { role: 'user', content: text }],
  { maxTokens: 4000, temperature: 0.2, reasoning: 'off' });
r.text; r.model; r.provider; r.usage; // usage.cost is null when the provider reports none

// JSON (parsed, fences / <think> stripped, checked against `schema` when given)
const j = await ai.json('MATCH', messages, { schema: { type: 'object', required: ['results'] } });
j.data;

// Image (only for a role registered with vision: true)
await ai.json('POSTER', [{ role: 'user', content: [{ type: 'text', text: 'Mô tả poster' }, imagePart(pngBytes)] }]);
```

Options: `maxTokens`, `timeoutMs`, `temperature` (0), `reasoning` (`off|low|medium|high|{maxTokens}`;
`{maxTokens}` and `off` reach OpenRouter only), `schema` (json), `accept(value)` (validator; a throw moves on to the next
pair, a throw with `.permanent` counts as a content refusal), `estTokens`, `signal`,
`only: { provider, model }`.

Result (`AiResult`): `text`, `data` (json), `value` (what `accept` returned, else text/data),
`model`, `provider`, `key` (`k1`, never the key), `usage { promptTokens, completionTokens,
thoughtTokens, totalTokens, cost }`, `attempts [{ provider, model, reason }]`.

Errors: only `AiError`, with `attempts` and `kind`:

| `kind` | Meaning | Caller should |
| --- | --- | --- |
| `content` (`.permanent`) | every model refused or mangled this input | skip this input, keep going |
| `unavailable` (`.blocked`) | no pair usable now (keys, quota, outage) | stop and wait `retryAfterMs` |
| `failed` | anything else | count as an error, retry later |

`onCall(fn)` sees every attempt (`role, provider, model, key, ok, error, status, latencyMs,
promptTokens, completionTokens, thoughtTokens, cost`). Tests use `createAi({ env, transport })`
or `setTransport(fn)`; `AI_FAKE=1` answers without network or keys.

The default instance (`getAi()`) logs every failed attempt as one line, never a success, never a
key or prompt: `[ai] attempt role=MATCH provider=openrouter model=a/b key=k1 error="timeout"
status=- ms=180001 out=-` (`error` cut at 120 characters, `status`/`out` are `-` when unknown).

A model that refuses an input is skipped for the rest of that call. If the other models are then
parked or exhausted, the caller gets `content` (not `unavailable`): the input was refused, the
provider is not down.

## Adding a role

One line in `src/ai/config.js`:

```js
registerRole('POSTER', { vision: true, defaultOr: 'google/gemini-2.5-flash', timeoutMs: 60000 });
```

It then reads `ROUTER9_MODEL_POSTER`, `OPENROUTER_MODEL_POSTER`, `AI_TIMEOUT_MS_POSTER` and
`AI_PAID_DAILY_OUTPUT_TOKENS_POSTER` with no other change. A vision role skips models that
cannot read images (OpenRouter `/models` catalog, or a 400 saying so) and never uses 9router,
which takes text only. A role gets a 9router route only from `ROUTER9_MODEL_<ROLE>`,
`ROUTER9_MODEL_PRIMARY` or its `defaultR9` (MATCH: `oc/deepseek-v4.1-flash-free`).

`modelsFrom: 'MATCH'` makes a role read the donor's `ROUTER9_MODEL_MATCH` / `OPENROUTER_MODEL_MATCH`
(and default) wherever its own are empty; timeout, paid cap and ledger scope stay its own.
`DEDUPE` is registered that way (`ledgerScope: 'catalog-audit'`, 180000 ms).

## Routing and fallback

Which providers a role uses, and in what order, is `roleRouteOrder` (config.js): `AI_ROUTE_<ROLE>`, then
`AI_ROUTE`, then the role's `routes` (registerRole), then `9router,openrouter`. Names are
`9router|openrouter` (`router9` is an alias); an unknown name or an empty list is an
`AiConfigError` at startup. A leftover `opencode` (the removed sidecar) is skipped with one startup
warning, and a list naming only it counts as unset. The list only selects and orders: a listed provider with no keys or models
is still skipped, and a vision role never gets 9router. `modelsFrom` shares models, never
routes. MATCH has no `routes` (both); DEDUPE has `routes: 'openrouter'`, because in catalog audit
run 8 9router authored only 7 of 624 groups. Back to the 9router chain:
`AI_ROUTE_DEDUPE=9router,openrouter`.

- With `ROUTER9_API_KEY` (+ `ROUTER9_BASE_URL`, required with it): 9router first × `ROUTER9_MODEL_<ROLE>`
  (else `ROUTER9_MODEL_PRIMARY`, else the role default; MATCH: `oc/deepseek-v4.1-flash-free`). It is a plain
  OpenAI-compatible `POST {base}/chat/completions` with `Authorization: Bearer`, no OpenRouter-only
  fields (`usage`, `reasoning`, referer headers, `/models`); reasoning goes as `reasoning_effort`. Text
  only: a vision role gets no 9router route. 9router is a separate container stack (`/opt/stacks/9router`,
  pinned image, its own backup); the worker reaches it at `http://9router:20128/v1` over the external
  network `blueflare-ai` that only they share. Create it once: `docker network create blueflare-ai`.
- With `OPENROUTER_API_KEY` alone: OpenRouter only. With 9router too: 9router first, then OpenRouter.
- Next pair on 401 (key off), 402 / 403 "key limit" (model parked), 408/429/5xx (after
  `AI_RETRIES` tries), network error, timeout, empty answer, bad JSON, schema or `accept`
  failure, no vision. A daily 429 on an OpenRouter `:free` model parks all `:free` models of
  that key until 00:00 UTC.
- Park ladder of a pair (provider+model+key) that keeps failing, reset to 0 when it succeeds:
  timeout or network error parks `min(max(2 x timeout, 45 s) x 2^fails, 30 min, AI_COOLDOWN_MS)`
  (180 s timeout: 6, 12, 24, 30, 30 min); 408/5xx after `AI_RETRIES` tries keeps the short ladder
  45 s doubling up to 5 min.
- JSON: `response_format` goes `json_schema → json_object → none` (prompt instruction) and the
  level that worked is remembered per provider+model.
- OpenRouter only: `usage: {include: true}`, `reasoning`, `HTTP-Referer`/`X-Title`, `/models`.
- Budget: one place, the quota ledger (`ai_quota_ledger`): per key+model requests per day
  (`rpd`), RPM spacing, and `AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>` over paid models (free:
`…:free`, `…-free`, `openrouter/free`).
- Keys travel only in the `Authorization` header; logs name them
  `k1 (<6 hex of sha256>)`.

## Env

Defaults live in `src/ai/config.js` (`AI_DEFAULTS`, roles); `.env.example` mirrors them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_ROUTE` / `AI_ROUTE_<ROLE>` | role default (MATCH: both; DEDUPE: `openrouter`) | comma list of `9router|openrouter`, order = order of attempts |
| `ROUTER9_BASE_URL` | empty | 9router base URL incl. `/v1`; required when `ROUTER9_API_KEY` is set (startup error otherwise) |
| `ROUTER9_API_KEY` | empty | secret, comma list; empty = no 9router route |
| `ROUTER9_MODEL_PRIMARY` / `_<ROLE>` | role default (MATCH: `oc/deepseek-v4.1-flash-free`) | `id[:rpm[:rpd]]`, best first |
| `OPENROUTER_API_KEY` | empty | secret, comma list; empty = no OpenRouter |
| `OPENROUTER_MODEL_PRIMARY` / `_<ROLE>` | role default | `id[:rpm[:rpd]]`, best first |
| `AI_TIMEOUT_MS` / `AI_TIMEOUT_MS_<ROLE>` | role default (60000, MATCH and DEDUPE 180000) | per request |
| `AI_MAX_TOKENS` | 8192 | completion ceiling when a call names none |
| `AI_REASONING` / `AI_REASONING_<ROLE>` | role's `reasoning` (MATCH, DEDUPE: `medium`) | `off|low|medium|high`, overrides the caller's `reasoning`; empty = the role's default, `off` = no reasoning; the caller's own `reasoning` applies only to a role without a default. Sent as `reasoning` to OpenRouter, as `reasoning_effort` to 9router |
| `AI_RETRIES` | 2 | extra tries of a pair on 429/5xx |
| `AI_COOLDOWN_MS` | 3600000 | longest park of a key/model |
| `AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>` | role's `paidCap` (MATCH, DEDUPE: 1000000) | paid completion tokens per UTC day; 0 = no cap |
| `AI_FAKE` | empty | `1` = canned answers, no network |

Old names still work and log a deprecation warning at worker start:
`OPENROUTER_API_KEYS`→`OPENROUTER_API_KEY`, `OPENROUTER_MATCH_MODELS`→`OPENROUTER_MODEL_MATCH`,
`OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS`→`AI_PAID_DAILY_OUTPUT_TOKENS_MATCH`,
`TMDB_MATCH_AI_TIMEOUT_MS`→`AI_TIMEOUT_MS_MATCH`,
`OPENROUTER_COOLDOWN_MS`→`AI_COOLDOWN_MS`. `OPENROUTER_BASE_URL` and
`TMDB_MATCH_AI_TRANSIENT_PARK_{MS,MAX_MS}` are now constants (a set value is still used, with a
warning); `TMDB_MATCH_AI_RESERVE_PCT` is ignored. The removed primary provider's
`LLM_BASE_URL`, `LLM_API_KEY` and every `MODEL_*` (`MODEL_PRIMARY`, `MODEL_FALLBACK`,
`MODEL_<ROLE>`) are no longer read and log "remove it". The same holds for the removed opencode
sidecar's `OPENCODE_URL`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_MODEL_PRIMARY`, `OPENCODE_MODEL_<ROLE>` and
`OPENCODE_CREDENTIALS_DIR`: a stack `.env` that still has them boots normally.
