import { parseKeys, parseModels } from './util.js';

/**
 * The single place where AI settings and their defaults live. `.env.example` mirrors AI_DEFAULTS.
 *
 *   ROUTER9_BASE_URL             9router (OpenAI-compatible router), tried before everything else; with ROUTER9_API_KEY
 *   ROUTER9_API_KEY              9router key (comma list allowed); empty = no 9router route
 *   ROUTER9_MODEL_<ROLE>         9router models of a role; ROUTER9_MODEL_PRIMARY, then the role default
 *   OPENROUTER_API_KEY           fallback provider (comma list allowed)
 *   OPENROUTER_MODEL_<ROLE>      OpenRouter models of a role; OPENROUTER_MODEL_PRIMARY, then the role default
 *   AI_ROUTE_<ROLE>, AI_ROUTE    which providers a role uses and in what order: comma list of 9router|openrouter
 *                                (alias router9; a leftover `opencode` is ignored with a warning); the role's own
 *                                `routes`, then both in that order, when unset
 *   AI_TIMEOUT_MS[_<ROLE>]       per-request timeout; empty = the role default
 *   AI_MAX_TOKENS                default completion ceiling when a call names none
 *   AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>  completion tokens per UTC day over non-`:free` models; empty = the
 *                                role's `paidCap`, 0 = no cap
 *   AI_REASONING[_<ROLE>]        off|low|medium|high; overrides what the caller asks for; empty = the role's
 *                                `reasoning`, then the caller's choice
 *   AI_RETRIES, AI_COOLDOWN_MS   technical knobs (see AI_DEFAULTS)
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const AI_DEFAULTS = Object.freeze({
  timeoutMs: 60000, // AI_TIMEOUT_MS when neither the call, AI_TIMEOUT_MS_<ROLE>, AI_TIMEOUT_MS nor the role names one
  maxTokens: 8192, // AI_MAX_TOKENS
  retries: 2, // AI_RETRIES: extra tries of the same provider+model on 429/5xx before moving on
  cooldownMs: 60 * 60 * 1000, // AI_COOLDOWN_MS: longest park (rejected key, model out of credit or gone)
  transientParkMs: 45000, // a pair that keeps failing (5xx, timeout) sits out 45s, doubling...
  transientParkMaxMs: 5 * 60 * 1000, // ...up to 5 min
  timeoutParkMaxMs: 30 * 60 * 1000 // a timeout or network error parks longer: max(2 x timeout, transientParkMs), doubling, up to 30 min
});

export const ROUTE_NAMES = Object.freeze(['9router', 'openrouter']);
const DEFAULT_ROUTES = ROUTE_NAMES;

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
 * skipped; 9router is never used for them). `defaultR9` / `defaultOr`: 9router / OpenRouter models when no env names any. Optional `timeoutMs`,
 * `maxTokens`, `reasoning` (level when AI_REASONING names none), `paidCap` (daily paid output
 * tokens when AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE> is empty), `ledgerScope` (quota counters; defaults to the lower-case name), `modelsFrom`
 * (another role whose ROUTER9_MODEL_/OPENROUTER_MODEL_ lists and defaults this role uses when its own
 * env names none; the paid cap and ledger scope stay this role's own), `routes` (providers the role may use,
 * in order, comma string or array of 9router|openrouter; null = both; AI_ROUTE_<ROLE> / AI_ROUTE
 * win; never inherited through `modelsFrom`).
 */
/** Comma string or array -> canonical route names (router9 = 9router), duplicates dropped, `opencode` skipped (so the result may be empty). Throws on an unknown name or an empty list. */
function parseRouteList(value, label) {
  const items = (Array.isArray(value) ? value : String(value).split(',')).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (!items.length) throw new AiConfigError(label + ' names no provider (use ' + ROUTE_NAMES.join('|') + ')');
  const out = [];
  for (const item of items) {
    if (item === 'opencode') continue; // removed provider: readAiConfig warns once, a stale stack .env must still boot
    const name = item === 'router9' ? '9router' : item;
    if (!ROUTE_NAMES.includes(name)) throw new AiConfigError(label + ' has unknown provider "' + item + '" (use ' + ROUTE_NAMES.join('|') + ')');
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function registerRole(name, spec = {}) {
  const key = String(name ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new TypeError('invalid AI role name: ' + name);
  const role = Object.freeze({
    name: key,
    vision: Boolean(spec.vision),
    defaultR9: String(spec.defaultR9 ?? ''),
    defaultOr: String(spec.defaultOr ?? ''),
    timeoutMs: Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : null,
    maxTokens: Number(spec.maxTokens) > 0 ? Number(spec.maxTokens) : null,
    reasoning: spec.reasoning ? String(spec.reasoning) : null,
    paidCap: Number(spec.paidCap) > 0 ? Number(spec.paidCap) : null,
    ledgerScope: String(spec.ledgerScope ?? key.toLowerCase()),
    modelsFrom: spec.modelsFrom ? String(spec.modelsFrom).toUpperCase() : null,
    routes: spec.routes == null ? null : parseRouteList(spec.routes, 'role ' + key + ' routes')
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

// Each role has its own paid cap: DEDUPE borrows MATCH's (partly paid) models, so it must not run uncapped.
registerRole('MATCH', { defaultR9: 'oc/deepseek-v4.1-flash-free', defaultOr: 'openrouter/free', timeoutMs: 180000, reasoning: 'medium', paidCap: 1_000_000, ledgerScope: 'tmdb-match' });
// DEDUPE borrows MATCH's models but not its routes: 9router authored 7 of 624 groups in run 8.
registerRole('DEDUPE', { modelsFrom: 'MATCH', routes: 'openrouter', timeoutMs: 180000, reasoning: 'medium', paidCap: 1_000_000, ledgerScope: 'catalog-audit' });

// ---- env --------------------------------------------------------------------------------

/** Old name -> new name. The old one still works for now and logs a warning at startup. */
export const RENAMED_ENV = Object.freeze({
  OPENROUTER_API_KEYS: 'OPENROUTER_API_KEY',
  OPENROUTER_MATCH_MODELS: 'OPENROUTER_MODEL_MATCH',
  OPENROUTER_MATCH_PAID_DAILY_OUTPUT_TOKENS: 'AI_PAID_DAILY_OUTPUT_TOKENS_MATCH',
  TMDB_MATCH_AI_TIMEOUT_MS: 'AI_TIMEOUT_MS_MATCH',
  OPENROUTER_COOLDOWN_MS: 'AI_COOLDOWN_MS'
});

/** Settings that became constants. A value still set is used for now, with a warning. */
const FOLDED_ENV = Object.freeze({
  OPENROUTER_BASE_URL: 'openrouterBaseUrl',
  TMDB_MATCH_AI_TRANSIENT_PARK_MS: 'transientParkMs',
  TMDB_MATCH_AI_TRANSIENT_PARK_MAX_MS: 'transientParkMaxMs'
});

// The OpenAI-compatible primary provider (LLM_BASE_URL) and the opencode sidecar are gone.
const UNUSED_ENV = Object.freeze([
  'TMDB_MATCH_AI_RESERVE_PCT', 'LLM_BASE_URL', 'LLM_API_KEY', 'MODEL_PRIMARY', 'MODEL_FALLBACK',
  'OPENCODE_URL', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_MODEL_PRIMARY', 'OPENCODE_CREDENTIALS_DIR'
]);
// MODEL_<ROLE> (old) and OPENCODE_MODEL_<ROLE>: now ROUTER9_MODEL_<ROLE> / OPENROUTER_MODEL_<ROLE>
const UNUSED_ENV_PATTERN = /^(OPENCODE_)?MODEL_[A-Z][A-Z0-9_]*$/;

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
  for (const [name, value] of Object.entries(env)) if (/^(ROUTER9_|OPENROUTER_|AI_)/.test(name)) view[name] = value;
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
  const unused = [...new Set([...UNUSED_ENV, ...Object.keys(env).filter((name) => UNUSED_ENV_PATTERN.test(name))])];
  for (const name of unused) {
    if (!text(env[name])) continue;
    deprecated.push(name);
    warn('[ai] ' + name + ' is no longer read; remove it');
  }

  // 9router: an OpenAI-compatible router. Name `9router` (env prefix ROUTER9_: a shell name cannot start with a digit).
  let router9 = null;
  const router9Keys = parseKeys(view.ROUTER9_API_KEY);
  const router9Url = text(view.ROUTER9_BASE_URL).replace(/\/+$/, '');
  if (router9Keys.length || router9Url) {
    if (!router9Url) throw new AiConfigError('ROUTER9_BASE_URL is required when ROUTER9_API_KEY is set');
    let url;
    try { url = new URL(router9Url); } catch { throw new AiConfigError('ROUTER9_BASE_URL is not a valid URL'); }
    if (!/^https?:$/.test(url.protocol)) throw new AiConfigError('ROUTER9_BASE_URL must be http(s)');
    router9 = { name: '9router', kind: 'openai', baseUrl: router9Url, keys: router9Keys, openrouter: false };
  }
  const openrouterBaseUrl = text(folded.openrouterBaseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const openrouter = { name: 'openrouter', baseUrl: openrouterBaseUrl, keys: parseKeys(view.OPENROUTER_API_KEY), openrouter: true };

  for (const name of Object.keys(view)) {
    if (/^AI_ROUTE(_[A-Z0-9_]+)?$/.test(name) && text(view[name]).toLowerCase().split(',').some((item) => item.trim() === 'opencode')) {
      warn('[ai] ' + name + ' names opencode, which is no longer a provider: ignored; remove it');
    }
  }
  for (const name of roles.keys()) roleRouteOrder({ view }, name); // fail at startup on a bad AI_ROUTE*
  for (const name of roles.keys()) roleReasoning({ view }, name); // fail at startup on a bad AI_REASONING
  const parkMs = Number(folded.transientParkMs);
  const parkMaxMs = Number(folded.transientParkMaxMs);
  return Object.freeze({
    view: Object.freeze(view),
    router9,
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
 * Provider names a role may use, in order: AI_ROUTE_<ROLE>, AI_ROUTE, the role's `routes`, then all of
 * 9router, openrouter. A list naming only `opencode` counts as unset. Throws AiConfigError on an unknown name or an empty list.
 */
export function roleRouteOrder(cfg, roleName) {
  const role = getRole(roleName);
  const specific = text(cfg.view['AI_ROUTE_' + role.name]);
  const fromSpecific = specific ? parseRouteList(specific, 'AI_ROUTE_' + role.name) : [];
  if (fromSpecific.length) return fromSpecific;
  const general = text(cfg.view.AI_ROUTE);
  const fromGeneral = general ? parseRouteList(general, 'AI_ROUTE') : [];
  if (fromGeneral.length) return fromGeneral;
  return role.routes ? [...role.routes] : [...DEFAULT_ROUTES];
}

/**
 * Where a role's calls go, in order: `[{ provider, models }]`, routes without keys or models
 * left out. 9router x ROUTER9_MODEL_<ROLE> (else ROUTER9_MODEL_PRIMARY, else `defaultR9`), then OpenRouter x OPENROUTER_MODEL_<ROLE> (else OPENROUTER_MODEL_PRIMARY, else
 * `defaultOr`). A role with `modelsFrom` reads the donor role's lists and defaults where its own
 * are empty. A vision role gets no 9router route (text only). Only the providers
 * of roleRouteOrder are kept, in that order.
 */
export function roleRoutes(cfg, roleName) {
  const role = getRole(roleName);
  const donor = role.modelsFrom ? getRole(role.modelsFrom) : null;
  const v = cfg.view;
  const named = (prefix) => text(v[prefix + role.name]) || (donor ? text(v[prefix + donor.name]) : '');
  const orModels = named('OPENROUTER_MODEL_') || text(v.OPENROUTER_MODEL_PRIMARY) || role.defaultOr || donor?.defaultOr || '';
  const r9Models = named('ROUTER9_MODEL_') || text(v.ROUTER9_MODEL_PRIMARY) || role.defaultR9 || donor?.defaultR9 || '';
  const built = new Map();
  const routes = [];
  // 9router first; text only (its models' image support is unknown).
  if (cfg.router9 && !role.vision) built.set('9router', { provider: cfg.router9, models: parseModels(r9Models, { freeRpm: 0 }) });
  built.set('openrouter', { provider: cfg.openrouter, models: parseModels(orModels) });
  for (const name of roleRouteOrder(cfg, role.name)) if (built.has(name)) routes.push(built.get(name));
  return routes.filter((route) => route.provider.keys.length && route.models.length);
}

/** Per-request timeout of a role: AI_TIMEOUT_MS_<ROLE>, AI_TIMEOUT_MS, the role default, then the global default. */
export function roleTimeoutMs(cfg, roleName) {
  const role = getRole(roleName);
  return positiveInt(cfg.view, 'AI_TIMEOUT_MS_' + role.name, null, () => {}, 1000) ?? cfg.timeoutMs ?? role.timeoutMs ?? AI_DEFAULTS.timeoutMs;
}

/** AI_PAID_DAILY_OUTPUT_TOKENS_<ROLE>, else the role's paidCap; 0 = no cap (null). */
export function rolePaidCap(cfg, roleName) {
  const role = getRole(roleName);
  const value = positiveInt(cfg.view, 'AI_PAID_DAILY_OUTPUT_TOKENS_' + role.name, role.paidCap ?? 0, () => {}, 0);
  return value > 0 ? value : null;
}

const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

/** AI_REASONING_<ROLE>, AI_REASONING, then the role's reasoning; null = leave it to the caller. Throws on an unknown level. */
export function roleReasoning(cfg, roleName) {
  const role = getRole(roleName);
  const raw = text(cfg.view['AI_REASONING_' + role.name]) || text(cfg.view.AI_REASONING) || text(role.reasoning);
  if (!raw) return null;
  const level = raw.toLowerCase();
  if (!REASONING_LEVELS.includes(level)) throw new AiConfigError('AI_REASONING must be one of ' + REASONING_LEVELS.join('|'));
  return level;
}
