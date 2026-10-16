# AI module

Every model call in the backend goes through `backend/src/ai/`. No other file talks to
an LLM over HTTP, reads AI env variables or implements fallback. Callers today: review
translation (role `TRANSLATE`, `translate.js`) and the TMDB AI match (role `MATCH`,
`tmdbMatchAi.js`).

## Calling it

```js
import { getAi, imagePart, AiError } from './ai/index.js';

const ai = getAi(); // process-wide instance; throws AiConfigError on a broken env

// Text
const r = await ai.chat('TRANSLATE', [{ role: 'system', content: 'Dịch sang tiếng Việt.' }, { role: 'user', content: text }],
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

It then reads `MODEL_POSTER`, `OPENROUTER_MODEL_POSTER`, `AI_TIMEOUT_MS_POSTER` and
`AI_PAID_DAILY_OUTPUT_TOKENS_POSTER` with no other change. A vision role skips models that
cannot read images (OpenRouter `/models` catalog, or a 400 saying so).

## Routing and fallback

- With `LLM_BASE_URL`: primary × `MODEL_<ROLE>` (else `MODEL_PRIMARY`, `MODEL_FALLBACK`),
  then OpenRouter × `OPENROUTER_MODEL_<ROLE>` (else `OPENROUTER_MODEL_PRIMARY`, else the role
  default). Without it: OpenRouter × `MODEL_<ROLE>` (else the OpenRouter list).
- Next pair on 401 (key off), 402 / 403 "key limit" (model parked), 408/429/5xx (after
  `AI_RETRIES` tries), network error, timeout, empty answer, bad JSON, schema or `accept`
  failure, no vision. A daily 429 on an OpenRouter `:free` model parks all `:free` models of
  that key until 00:00 UTC.
- JSON: `response_format` goes `json_schema → json_object → none` (prompt instruction) and the
  level that worked is remembered per provider+model.
- OpenRouter only: `usage: {include: true}`, `reasoning`, `HTTP-Referer`/`X-Title`, `/models`.
- Budget: one place, the quota ledger (`ai_quota_ledger`): per key+model requests per day
  (`rpd`), RPM spacing, and `AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>` over non-`:free` models.
- Keys travel only in the `Authorization` header; logs name them `k1 (<6 hex of sha256>)`.

## Env

Defaults live in `src/ai/config.js` (`AI_DEFAULTS`, roles); `.env.example` mirrors them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_BASE_URL` | empty | primary OpenAI-compatible base (`…/v1`); empty = OpenRouter only |
| `LLM_API_KEY` | empty | secret; required when `LLM_BASE_URL` is set (startup error otherwise) |
| `MODEL_PRIMARY`, `MODEL_FALLBACK` | empty | primary models of every role without `MODEL_<ROLE>` |
| `MODEL_<ROLE>` | empty | primary models of one role, in order |
| `OPENROUTER_API_KEY` | empty | secret, comma list; empty = no OpenRouter |
| `OPENROUTER_MODEL_PRIMARY` / `_<ROLE>` | role default | `id[:rpm[:rpd]]`, best first |
| `AI_TIMEOUT_MS` / `AI_TIMEOUT_MS_<ROLE>` | role default (60000, MATCH 180000) | per request |
| `AI_MAX_TOKENS` | 8192 | completion ceiling when a call names none |
| `AI_REASONING` / `AI_REASONING_<ROLE>` | empty | `off|low|medium|high`, overrides the caller's `reasoning`; empty = caller's choice. Sent as `reasoning` to OpenRouter and `reasoning_effort` to the primary |
| `AI_RETRIES` | 2 | extra tries of a pair on 429/5xx |
| `AI_COOLDOWN_MS` | 3600000 | longest park of a key/model |
| `AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>` | 0 | paid completion tokens per UTC day; 0 = no cap |
| `AI_FAKE` | empty | `1` = canned answers, no network |

Old names still work and log a deprecation warning at worker start:
`OPENROUTER_API_KEYS`→`OPENROUTER_API_KEY`, `OPENROUTER_{MATCH,TRANSLATE}_MODELS`→`OPENROUTER_MODEL_{MATCH,TRANSLATE}`,
`OPENROUTER_{MATCH,TRANSLATE}_PAID_DAILY_OUTPUT_TOKENS`→`AI_PAID_DAILY_OUTPUT_TOKENS_{MATCH,TRANSLATE}`,
`TMDB_MATCH_AI_TIMEOUT_MS`→`AI_TIMEOUT_MS_MATCH`, `OPENROUTER_TIMEOUT_MS`→`AI_TIMEOUT_MS_TRANSLATE`,
`OPENROUTER_COOLDOWN_MS`→`AI_COOLDOWN_MS`. `OPENROUTER_BASE_URL` and
`TMDB_MATCH_AI_TRANSIENT_PARK_{MS,MAX_MS}` are now constants (a set value is still used, with a
warning); `TMDB_MATCH_AI_RESERVE_PCT` is ignored.
