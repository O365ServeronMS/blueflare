import { createAi, AiError, imagePart, fakeTransport } from './client.js';
import { AiConfigError, AI_DEFAULTS, readAiConfig, registerRole, roleNames } from './config.js';
import { createQuotaLedger } from '../aiQuotaLedger.js';
import { createPgQuotaStore } from '../aiQuotaStore.js';

/**
 * Public entry of the AI module (see backend/AI.md). The default instance reads process.env
 * once, keeps quota in PostgreSQL (ai_quota_ledger) and is shared by every role, so parks
 * and learned response_format levels are shared too.
 */

export { createAi, AiError, AiConfigError, AI_DEFAULTS, imagePart, fakeTransport, readAiConfig, registerRole, roleNames };

let instance = null;
let pendingTransport;

/** The process-wide instance; throws AiConfigError on a broken AI env (call it at startup). */
export function getAi() {
  if (!instance) {
    instance = createAi({ ledger: createQuotaLedger({ store: createPgQuotaStore() }) });
    if (pendingTransport !== undefined) instance.setTransport(pendingTransport);
  }
  return instance;
}

export const chat = (role, messages, options) => getAi().chat(role, messages, options);
export const json = (role, messages, options) => getAi().json(role, messages, options);
export const onCall = (listener) => getAi().onCall(listener);

/** Replace HTTP for the default instance (tests); null restores fetch (or the fake under AI_FAKE=1). */
export function setTransport(fn) {
  pendingTransport = fn;
  instance?.setTransport(fn);
}

/** Forget the default instance (tests that change process.env). */
export function resetAi() {
  instance = null;
}
