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

## Adding a role

One line in `src/ai/config.js`:

```js
registerRole('POSTER', { vision: true, defaultOr: 'google/gemini-2.5-flash', timeoutMs: 60000 });
```

It then reads `OPENCODE_MODEL_POSTER`, `OPENROUTER_MODEL_POSTER`, `AI_TIMEOUT_MS_POSTER` and
`AI_PAID_DAILY_OUTPUT_TOKENS_POSTER` with no other change. A vision role skips models that
cannot read images (OpenRouter `/models` catalog, or a 400 saying so) and never uses opencode,
which takes text only. A role gets an opencode route only from `OPENCODE_MODEL_<ROLE>`,
`OPENCODE_MODEL_PRIMARY` or its `defaultOc` (MATCH: `opencode/big-pickle`).

`modelsFrom: 'MATCH'` makes a role read the donor's `OPENCODE_MODEL_MATCH` / `OPENROUTER_MODEL_MATCH`
(and default) wherever its own are empty; timeout, paid cap and ledger scope stay its own.
`DEDUPE` is registered that way (`ledgerScope: 'catalog-audit'`, 180000 ms).

## Routing and fallback

- With `ROUTER9_API_KEY` (+ `ROUTER9_BASE_URL`, required with it): 9router first × `ROUTER9_MODEL_<ROLE>`
  (else `ROUTER9_MODEL_PRIMARY`, else the role default; MATCH: `oc/deepseek-v4.1-flash-free`). It is a plain
  OpenAI-compatible `POST {base}/chat/completions` with `Authorization: Bearer`, no OpenRouter-only
  fields (`usage`, `reasoning`, referer headers, `/models`); reasoning goes as `reasoning_effort`. Text
  only: a vision role gets no 9router route. 9router is a separate container stack (`/opt/stacks/9router`,
  pinned image, its own backup); the worker reaches it at `http://9router:20128/v1` over the external
  network `blueflare-ai` that only they share. Create it once: `docker network create blueflare-ai`.
- With `OPENCODE_URL`: opencode × `OPENCODE_MODEL_<ROLE>` (else `OPENCODE_MODEL_PRIMARY`, else
  the role default), then OpenRouter × `OPENROUTER_MODEL_<ROLE>` (else `OPENROUTER_MODEL_PRIMARY`,
  else the role default). Without it: OpenRouter only.
- opencode is the `opencode` compose service (opencode v2 `opencode serve`, basic auth
  `opencode:OPENCODE_SERVER_PASSWORD`). Per key+model the module makes one session of the stock
  `plan` agent (`POST /api/session {title: 'blueflare-ai', agent: 'plan', model}`), then every
  call is `POST /api/session/{id}/generate {prompt}`: a stateless generation (nothing is added to
  the session, no tool runs) that answers `{text, tokens, cost}`. A session that is gone (404) is
  made again once. Only one opencode call is in flight at a time (every role and model queue on
  it): parallel free-tier generations drew "Free usage limit reached" and hung for minutes. Time
  spent queued counts toward the call's timeout, so a long queue ends on OpenRouter.
- Why a session and a stock agent: opencode Zen serves its free models only to requests that
  carry a stock opencode agent's system prompt and tools. `/api/experimental/generate/text` (no
  agent), the short `title`/`summary` agents and a `plan` session with changed `permissions` all
  get "Free usage limit reached" while a plain `plan` session works (measured 2026-11-12). The
  cost is ~7-9k prompt tokens of agent prompt per call, mostly served from opencode's cache.
- The messages are flattened into one prompt (system text first; several turns are labelled
  `USER:` / `ASSISTANT:`). There is no temperature, max_tokens, reasoning or `response_format`,
  so JSON is always asked for in the prompt. Errors are mapped onto the same status rules as
  OpenRouter: `ServiceUnavailableError` "Free usage limit reached" → 429, parking every opencode
  model for `AI_COOLDOWN_MS` (or until `retryAfterMs` when opencode states one), "Model
  unavailable" → 404, any other → 503; `ProviderRequestError {reason, status, retryAfterMs}`
  by its reason. Meanwhile the calls go on through OpenRouter.
- Next pair on 401 (key off), 402 / 403 "key limit" (model parked), 408/429/5xx (after
  `AI_RETRIES` tries), network error, timeout, empty answer, bad JSON, schema or `accept`
  failure, no vision. A daily 429 on an OpenRouter `:free` model parks all `:free` models of
  that key until 00:00 UTC.
- JSON: `response_format` goes `json_schema → json_object → none` (prompt instruction) and the
  level that worked is remembered per provider+model.
- OpenRouter only: `usage: {include: true}`, `reasoning`, `HTTP-Referer`/`X-Title`, `/models`.
- Budget: one place, the quota ledger (`ai_quota_ledger`): per key+model requests per day
  (`rpd`), RPM spacing, and `AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>` over paid models (free:
`…:free`, `…-free`, `openrouter/free`, `opencode/big-pickle`).
- Keys and the opencode password travel only in the `Authorization` header; logs name them
  `k1 (<6 hex of sha256>)`.

## Env

Defaults live in `src/ai/config.js` (`AI_DEFAULTS`, roles); `.env.example` mirrors them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROUTER9_BASE_URL` | empty | 9router base URL incl. `/v1`; required when `ROUTER9_API_KEY` is set (startup error otherwise) |
| `ROUTER9_API_KEY` | empty | secret, comma list; empty = no 9router route |
| `ROUTER9_MODEL_PRIMARY` / `_<ROLE>` | role default (MATCH: `oc/deepseek-v4.1-flash-free`) | `id[:rpm[:rpd]]`, best first |
| `OPENCODE_URL` | empty | the opencode sidecar (`http://opencode:4096` in the stack); empty = OpenRouter only |
| `OPENCODE_SERVER_PASSWORD` | empty | secret, sidecar basic-auth password, shared by the `opencode` service and the worker; required when `OPENCODE_URL` is set (startup error otherwise) |
| `OPENCODE_MODEL_PRIMARY` / `_<ROLE>` | role default (MATCH: `opencode/big-pickle`) | `providerID/modelID`, comma list, best first |
| `OPENCODE_CREDENTIALS_DIR` | `./opencode` | compose only: host dir mounted read-only at `/run/opencode`; its `credentials.json` (`opencode auth export opencode`, 0600) is imported when it changes |
| `OPENROUTER_API_KEY` | empty | secret, comma list; empty = no OpenRouter |
| `OPENROUTER_MODEL_PRIMARY` / `_<ROLE>` | role default | `id[:rpm[:rpd]]`, best first |
| `AI_TIMEOUT_MS` / `AI_TIMEOUT_MS_<ROLE>` | role default (60000, MATCH and DEDUPE 180000) | per request |
| `AI_MAX_TOKENS` | 8192 | completion ceiling when a call names none |
| `AI_REASONING` / `AI_REASONING_<ROLE>` | role's `reasoning` (MATCH, DEDUPE: `medium`) | `off|low|medium|high`, overrides the caller's `reasoning`; empty = the role's default, `off` = no reasoning; the caller's own `reasoning` applies only to a role without a default. Sent as `reasoning` to OpenRouter; opencode takes none |
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
`MODEL_<ROLE>`) are no longer read and log "remove it".

## opencode login

The sidecar keeps its own login in the `opencode-data` volume. To give it (or renew) the
login of the host's `opencode auth login`:

```sh
umask 077; opencode auth export opencode > /opt/stacks/blueflare/opencode/credentials.json
docker restart blueflare-opencode   # imports it, since the file changed
```

The host CLI and the sidecar then hold the same refresh token; if opencode rotates it on
one side, the other may need a fresh export.
