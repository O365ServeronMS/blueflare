import { config } from './config.js';
import { createOpenRouterRotation } from './openrouter.js';

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

/** The AI pass runs only when enabled AND an OpenRouter key exists. */
export function tmdbMatchAiAvailable(settings = config) {
  return Boolean(settings.tmdbMatchAiEnabled) && (settings.openrouterApiKeys?.length ?? 0) > 0;
}

/**
 * Rotation instance for TMDB candidate ranking, with its own state. Returns null (pass off)
 * without a key. `call({ text, buildBody(model), parse(json), meta })`; the provider is OpenRouter.
 */
export function createTmdbMatchRotation(settings = config, options = {}) {
  if (!tmdbMatchAiAvailable(settings)) return null;
  return createOpenRouterRotation({
    scope: 'tmdb-match',
    apiKeys: settings.openrouterApiKeys,
    models: settings.openrouterMatchModels,
    modelsName: 'OPENROUTER_MATCH_MODELS',
    baseUrl: settings.openrouterBaseUrl,
    timeoutMs: settings.tmdbMatchAiTimeoutMs,
    cooldownMs: settings.openrouterCooldownMs,
    transientParkMs: settings.tmdbMatchAiTransientParkMs,
    transientParkMaxMs: settings.tmdbMatchAiTransientParkMaxMs,
    dailyTokenCap: settings.openrouterMatchDailyTokens,
    paidDailyOutputCap: settings.openrouterMatchPaidDailyOutputTokens,
    ledger: options.ledger ?? null,
    signal: options.signal,
    blockedError: (message) => new MatchBlockedError(message),
    contentError: (message) => new MatchContentError(message),
    isContentError: (error) => error instanceof MatchContentError,
    fetchImpl: options.fetchImpl, state: options.state, now: options.now, sleep: options.sleep, warn: options.warn
  });
}
