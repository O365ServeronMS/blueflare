import { parseKeys, parseModels } from './util.js';

/**
 * The single place where AI settings and their defaults live. `.env.example` mirrors AI_DEFAULTS.
 *
 *   LLM_BASE_URL / LLM_API_KEY   primary OpenAI-compatible provider (empty base URL = OpenRouter only)
 *   OPENROUTER_API_KEY           fallback provider (comma list allowed)
 *   MODEL_<ROLE>                 primary models of a role, in order; MODEL_PRIMARY + MODEL_FALLBACK otherwise
 *   OPENROUTER_MODEL_<ROLE>      OpenRouter models of a role; OPENROUTER_MODEL_PRIMARY, then the role default
 *   AI_TIMEOUT_MS[_<ROLE>]       per-request timeout; empty = the role default
 *   AI_MAX_TOKENS                default completion ceiling when a call names none
 *   AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>  completion tokens per UTC day over non-`:free` models; 0 = no cap
 *   AI_REASONING[_<ROLE>]        off|low|medium|high; overrides what the caller asks for; empty = the caller's choice
 *   AI_RETRIES, AI_COOLDOWN_MS   technical knobs (see AI_DEFAULTS)
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const AI_DEFAULTS = Object.freeze({
  timeoutMs: 60000, // AI_TIMEOUT_MS when neither the call, AI_TIMEOUT_MS_<ROLE>, AI_TIMEOUT_MS nor the role names one
  maxTokens: 8192, // AI_MAX_TOKENS
  retries: 2, // AI_RETRIES: extra tries of the same provider+model on 429/5xx before moving on
  cooldownMs: 60 * 60 * 1000, // AI_COOLDOWN_MS: longest park (rejected key, model out of credit or gone)
  transientParkMs: 45000, // a pair that keeps failing (5xx, timeout) sits out 45s, doubling...
  transientParkMaxMs: 5 * 60 * 1000 // ...up to 5 min
});

export class AiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiConfigError';
  }
}

// ---- roles -------------------------------------------------------------------------------

const roles = new Map();

/**
 * One line per role. `vision`: the role may send images (models that cannot read them are
 * skipped). `defaultOr`: OpenRouter models when no env names any. Optional `timeoutMs`,
 * `maxTokens`, `ledgerScope` (quota counters; defaults to the lower-case name), `modelsFrom`
 * (another role whose MODEL_/OPENROUTER_MODEL_ lists and default this role uses when its own
 * env names none; the paid cap and ledger scope stay this role's own).
 */
export function registerRole(name, spec = {}) {
  const key = String(name ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new TypeError('invalid AI role name: ' + name);
  const role = Object.freeze({
    name: key,
    vision: Boolean(spec.vision),
    defaultOr: String(spec.defaultOr ?? ''),
    timeoutMs: Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : null,
    maxTokens: Number(spec.maxTokens) > 0 ? Number(spec.maxTokens) : null,
    ledgerScope: String(spec.ledgerScope ?? key.toLowerCase()),
    modelsFrom: spec.modelsFrom ? String(spec.modelsFrom).toUpperCase() : null
  });
  roles.set(key, role);
  return role;
}

export function getRole(name) {
  const role = roles.get(String(name ?? '').toUpperCase());
  if (!role) throw new TypeError('unknown AI role: ' + name + ' (registerRole it first)');
  return role;
}

export const roleNames = () => [...roles.keys()];

registerRole('MATCH', { defaultOr: 'nvidia/nemotron-3-super-120b-a12b:free', timeoutMs: 180000, ledgerScope: 'tmdb-match' });
registerRole('TRANSLATE', { ledgerScope: 'translate' });
registerRole('DEDUPE', { modelsFrom: 'MATCH', timeoutMs: 180000, ledgerScope: 'catalog-audit' });

// ---- env --------------------------------------------------------------------------------

/** Old name -> new name. The old one still works for now and logs a warning at startup. */
export const RENAMED_ENV = Object.freeze({
  OPENROUTER_API_KEYS: 'OPENROUTER_API_KEY',
  OPENROUTER_MATCH_MODELS: 'OPENROUTER_MODEL_MATCH',
  OPENROUTER_TRANSLATE_MODELS: 'OPENROUTER_MODEL_TRANSLATE',
  OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS: 'AI_PAID_DAILY_OUTPUT_TOKENS_MATCH',
  OPENROUTER_TRANSLATE_PAID_DAILY_OUTPUT_TOKENS: 'AI_PAID_DAILY_OUTPUT_TOKENS_TRANSLATE',
  TMDB_MATCH_AI_TIMEOUT_MS: 'AI_TIMEOUT_MS_MATCH',
  OPENROUTER_TIMEOUT_MS: 'AI_TIMEOUT_MS_TRANSLATE',
  OPENROUTER_COOLDOWN_MS: 'AI_COOLDOWN_MS'
});

/** Settings that became constants. A value still set is used for now, with a warning. */
const FOLDED_ENV = Object.freeze({
  OPENROUTER_BASE_URL: 'openrouterBaseUrl',
  TMDB_MATCH_AI_TRANSIENT_PARK_MS: 'transientParkMs',
  TMDB_MATCH_AI_TRANSIENT_PARK_MAX_MS: 'transientParkMaxMs'
});

const UNUSED_ENV = Object.freeze(['TMDB_MATCH_AI_RESERVE_PCT']);

const text = (value) => String(value ?? '').trim();

function positiveInt(view, name, fallback, warn, minimum = 1) {
  const raw = text(view[name]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= minimum) return value;
  warn('[ai] ' + name + ' is not an integer >= ' + minimum + ', using ' + fallback);
  return fallback;
}

/**
 * Read and validate the AI settings. Throws AiConfigError on a setting that cannot work
 * (base URL without key, malformed URL). Never logs a key.
 */
export function readAiConfig(env = process.env, options = {}) {
  const warn = options.warn ?? ((message) => console.warn(message));
  const view = {};
  for (const [name, value] of Object.entries(env)) if (/^(LLM_|MODEL_|OPENROUTER_|AI_)/.test(name)) view[name] = value;
  const deprecated = [];
  for (const [oldName, newName] of Object.entries(RENAMED_ENV)) {
    if (!text(env[oldName])) continue;
    deprecated.push(oldName);
    if (text(env[newName])) warn('[ai] ' + oldName + ' is deprecated and ignored because ' + newName + ' is set; remove it');
    else {
      view[newName] = env[oldName];
      warn('[ai] ' + oldName + ' is deprecated, rename it to ' + newName);
    }
  }
  const folded = {};
  for (const [oldName, field] of Object.entries(FOLDED_ENV)) {
    if (!text(env[oldName])) continue;
    deprecated.push(oldName);
    folded[field] = text(env[oldName]);
    warn('[ai] ' + oldName + ' is deprecated (now a built-in default); its value is still used, remove it to use the default');
  }
  for (const name of UNUSED_ENV) {
    if (!text(env[name])) continue;
    deprecated.push(name);
    warn('[ai] ' + name + ' is no longer read; remove it');
  }

  let primary = null;
  const baseUrl = text(view.LLM_BASE_URL).replace(/\/+$/, '');
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new AiConfigError('LLM_BASE_URL is not a valid URL'); }
    if (!/^https?:$/.test(url.protocol)) throw new AiConfigError('LLM_BASE_URL must be http(s)');
    const keys = parseKeys(view.LLM_API_KEY);
    if (!keys.length) throw new AiConfigError('LLM_API_KEY is required when LLM_BASE_URL is set');
    primary = { name: url.hostname, baseUrl, keys, openrouter: false };
  }
  const openrouterBaseUrl = text(folded.openrouterBaseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const openrouter = { name: 'openrouter', baseUrl: openrouterBaseUrl, keys: parseKeys(view.OPENROUTER_API_KEY), openrouter: true };

  for (const name of roles.keys()) roleReasoning({ view }, name); // fail at startup on a bad AI_REASONING
  const parkMs = Number(folded.transientParkMs);
  const parkMaxMs = Number(folded.transientParkMaxMs);
  return Object.freeze({
    view: Object.freeze(view),
    primary,
    openrouter,
    timeoutMs: positiveInt(view, 'AI_TIMEOUT_MS', null, warn, 1000),
    maxTokens: positiveInt(view, 'AI_MAX_TOKENS', AI_DEFAULTS.maxTokens, warn),
    retries: positiveInt(view, 'AI_RETRIES', AI_DEFAULTS.retries, warn, 0),
    cooldownMs: positiveInt(view, 'AI_COOLDOWN_MS', AI_DEFAULTS.cooldownMs, warn, 1000),
    transientParkMs: Number.isInteger(parkMs) && parkMs >= 1000 ? parkMs : AI_DEFAULTS.transientParkMs,
    transientParkMaxMs: Number.isInteger(parkMaxMs) && parkMaxMs >= 1000 ? parkMaxMs : AI_DEFAULTS.transientParkMaxMs,
    fake: ['1', 'true', 'yes', 'on'].includes(text(view.AI_FAKE).toLowerCase()),
    deprecated
  });
}

/**
 * Where a role's calls go, in order: `[{ provider, models }]`, routes without keys or models
 * left out. With a primary provider: primary x MODEL_<ROLE> (or MODEL_PRIMARY + MODEL_FALLBACK),
 * then OpenRouter x OPENROUTER_MODEL_<ROLE>. Without one: OpenRouter x MODEL_<ROLE>, falling back
 * to the OpenRouter list. A role with `modelsFrom` reads the donor role's lists where its own are empty.
 */
export function roleRoutes(cfg, roleName) {
  const role = getRole(roleName);
  const donor = role.modelsFrom ? getRole(role.modelsFrom) : null;
  const v = cfg.view;
  const named = (prefix) => text(v[prefix + role.name]) || (donor ? text(v[prefix + donor.name]) : '');
  const orModels = named('OPENROUTER_MODEL_') || text(v.OPENROUTER_MODEL_PRIMARY) || role.defaultOr || donor?.defaultOr || '';
  const routes = [];
  if (cfg.primary) {
    const own = named('MODEL_');
    const list = own || [text(v.MODEL_PRIMARY), text(v.MODEL_FALLBACK)].filter(Boolean).join(',');
    routes.push({ provider: cfg.primary, models: parseModels(list, { freeRpm: 0 }) });
    routes.push({ provider: cfg.openrouter, models: parseModels(orModels) });
  } else {
    routes.push({ provider: cfg.openrouter, models: parseModels(named('MODEL_') || orModels) });
  }
  return routes.filter((route) => route.provider.keys.length && route.models.length);
}

/** Per-request timeout of a role: AI_TIMEOUT_MS_<ROLE>, AI_TIMEOUT_MS, the role default, then the global default. */
export function roleTimeoutMs(cfg, roleName) {
  const role = getRole(roleName);
  return positiveInt(cfg.view, 'AI_TIMEOUT_MS_' + role.name, null, () => {}, 1000) ?? cfg.timeoutMs ?? role.timeoutMs ?? AI_DEFAULTS.timeoutMs;
}

/** AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>; null = no cap. */
export function rolePaidCap(cfg, roleName) {
  const value = positiveInt(cfg.view, 'AI_PAID_DAILY_OUTPUT_TOKENS_' + getRole(roleName).name, 0, () => {}, 0);
  return value > 0 ? value : null;
}

const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

/** AI_REASONING_<ROLE>, then AI_REASONING; null = leave it to the caller. Throws on an unknown level. */
export function roleReasoning(cfg, roleName) {
  const name = getRole(roleName).name;
  const raw = text(cfg.view['AI_REASONING_' + name]) || text(cfg.view.AI_REASONING);
  if (!raw) return null;
  const level = raw.toLowerCase();
  if (!REASONING_LEVELS.includes(level)) throw new AiConfigError('AI_REASONING must be one of ' + REASONING_LEVELS.join('|'));
  return level;
}
