import { config } from './config.js';
import { createTranslator } from './translate.js';
import {
  listPendingReviewTranslations,
  recordReviewTranslation,
  recordReviewTranslationFailure
} from './repository.js';

const defaultState = { cooldownUntil: 0 };

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalized(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Translate stored reviews that have no fresh Vietnamese text. Worker-only,
 * strictly sequential. A 'blocked' answer or too many consecutive errors ends
 * the pass and opens a cooldown (in memory: a restart simply retries once).
 * Returns the canonical slugs whose visible translations changed.
 */
export async function syncReviewTranslations(deps = {}) {
  const settings = deps.config ?? config;
  if (!settings.translateEnabled) return [];
  const state = deps.state ?? defaultState;
  const now = deps.now ?? (() => Date.now());
  if (now() < state.cooldownUntil) return [];

  const list = deps.listPending ?? listPendingReviewTranslations;
  const record = deps.record ?? recordReviewTranslation;
  const recordFailure = deps.recordFailure ?? recordReviewTranslationFailure;
  const sleep = deps.sleep ?? sleepMs;

  const pending = await list(settings.translateReviewsPerCycle);
  if (!pending.length) return [];
  const translate = deps.translate ?? createTranslator({
    provider: settings.translateProvider,
    timeoutMs: settings.translateTimeoutMs
  });

  const changed = new Set();
  const counts = { checked: 0, ok: 0, failed: 0, blocked: 0 };
  let consecutive = 0;
  for (const review of pending) {
    if (counts.checked > 0 && settings.translateDelayMs > 0) await sleep(settings.translateDelayMs);
    counts.checked += 1;
    try {
      const translated = String(await translate(review.content) ?? '').trim();
      if (!translated) throw new Error('empty translation');
      // Echoing the source (names, already Vietnamese) is stored as '' so the row leaves the queue.
      const value = normalized(translated) === normalized(review.content) ? '' : translated;
      if (await record(review.id, review.contentHash, value)) {
        counts.ok += 1;
        if (value) changed.add(review.slug);
      }
      consecutive = 0;
    } catch (error) {
      if (error?.blocked) {
        counts.blocked += 1;
        console.warn('[worker] review translate blocked:', error.message);
        state.cooldownUntil = now() + settings.translateCooldownMs;
        break;
      }
      counts.failed += 1;
      consecutive += 1;
      await recordFailure(review.id, { retryMs: settings.translateCooldownMs }).catch(() => {});
      console.warn('[worker] review translate failed for ' + review.slug, error?.message);
      if (consecutive >= settings.translateMaxConsecutiveErrors) {
        state.cooldownUntil = now() + settings.translateCooldownMs;
        break;
      }
    }
  }

  console.log('[worker] review translate checked=' + counts.checked + ' ok=' + counts.ok +
    ' failed=' + counts.failed + ' blocked=' + counts.blocked);
  return [...changed];
}
