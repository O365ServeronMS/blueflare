import { config } from './config.js';
import { createGeminiRotation } from './geminiRotation.js';

/** The match pass was refused by every key/model; retry later. */
export class MatchBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MatchBlockedError';
    this.blocked = true;
    this.retryAfterMs = null;
  }
}

/** One text the models refused (safety, truncation); not a provider outage. */
export class MatchContentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MatchContentError';
    this.permanent = true;
  }
}

/** The AI pass runs only when enabled AND it has its own keys. GEMINI_API_KEYS is deliberately never consulted. */
export function tmdbMatchAiAvailable(settings = config) {
  return Boolean(settings.tmdbMatchAiEnabled) && (settings.tmdbMatchGeminiApiKeys?.length ?? 0) > 0;
}

/**
 * Rotation instance for TMDB candidate ranking, with its own state. Returns
 * null (pass off) without its own keys. `call({ text, buildBody(model), parse(json), meta })`.
 */
export function createTmdbMatchRotation(settings = config, options = {}) {
  if (!tmdbMatchAiAvailable(settings)) return null;
  return createGeminiRotation({
    apiKeys: settings.tmdbMatchGeminiApiKeys,
    models: settings.tmdbMatchGeminiModels,
    timeoutMs: settings.tmdbMatchGeminiTimeoutMs,
    cooldownMs: settings.tmdbMatchGeminiCooldownMs,
    modelsName: 'TMDB_MATCH_GEMINI_MODELS',
    blockedError: (message) => new MatchBlockedError(message),
    contentError: (message) => new MatchContentError(message),
    isContentError: (error) => error instanceof MatchContentError,
    fetchImpl: options.fetchImpl, state: options.state, now: options.now, sleep: options.sleep, warn: options.warn
  });
}
