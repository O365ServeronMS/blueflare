import { config } from './config.js';
import { buildTranslators } from './translate.js';
import { packBatches } from './translateBatch.js';
import {
  listPendingReviewTranslations,
  recordReviewTranslation,
  recordReviewTranslationFailure
} from './repository.js';

const defaultState = { cooldownUntil: 0, providers: {} };

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalized(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

const label = (name) => String(name).replace(/^google-/, '');

/**
 * Translate stored reviews that have no fresh Vietnamese text. Worker-only,
 * strictly sequential. Providers form an ordered chain (TRANSLATE_PROVIDER): the
 * first one not in cooldown translates; a 'blocked' answer puts that provider in
 * cooldown and the SAME review continues with the next one. The pass ends when
 * no provider is left or after too many consecutive per-review errors. State is
 * in memory: a restart simply retries once.
 * Returns the canonical slugs whose visible translations changed.
 */
export async function syncReviewTranslations(deps = {}) {
  const settings = deps.config ?? config;
  if (!settings.translateEnabled) return [];
  const state = deps.state ?? defaultState;
  state.providers ??= {};
  const now = deps.now ?? (() => Date.now());
  if (now() < state.cooldownUntil) return [];

  const list = deps.listPending ?? listPendingReviewTranslations;
  const record = deps.record ?? recordReviewTranslation;
  const recordFailure = deps.recordFailure ?? recordReviewTranslationFailure;
  const sleep = deps.sleep ?? sleepMs;

  const providers = deps.providers
    ?? (deps.translate
      ? [{ name: String(settings.translateProvider).split(',')[0].trim() || 'google-gtx', translate: deps.translate, delayMs: settings.translateDelayMs, cooldownMs: settings.translateCooldownMs }]
      : null);
  const chain = providers ?? buildTranslators(settings, { state: (state.translators ??= {}), now, sleep });
  if (!chain.length) {
    if (!state.warnedNoProvider) {
      state.warnedNoProvider = true;
      console.warn('[worker] review translate: no usable provider (is OPENROUTER_API_KEYS set?)');
    }
    return [];
  }
  const stateOf = (name) => (state.providers[name] ??= { cooldownUntil: 0, errors: 0 });
  const available = () => chain.filter((p) => now() >= stateOf(p.name).cooldownUntil);
  if (!available().length) return [];

  let pending = await list(settings.translateReviewsPerCycle);
  if (!pending.length) return [];

  const changed = new Set();
  const counts = { checked: 0, ok: 0, failed: 0, blocked: 0 };
  const used = Object.fromEntries(chain.map((p) => [label(p.name), 0]));
  const modelUsed = {};
  const keyUsed = {};
  const lastCall = {};
  let consecutive = 0;

  const openCooldown = (provider, error) => {
    const wait = Number(error.retryAfterMs) > 0 ? error.retryAfterMs : provider.cooldownMs ?? settings.translateCooldownMs;
    stateOf(provider.name).cooldownUntil = now() + wait;
  };

  if (settings.translateBatchEnabled) {
    const batcher = available().find((p) => typeof p.translate.batch === 'function');
    if (batcher) {
      const leftover = new Set(pending.map((r) => r.id));
      const batchStats = { requests: 0, split: 0 };
      // Translate `group` in one request; a rejected answer splits it in two, down to single reviews (per-review path below).
      const run = async (group) => {
        if (group.length < 2 || now() < stateOf(batcher.name).cooldownUntil) return;
        const meta = {};
        let items;
        batchStats.requests += 1;
        try {
          items = await batcher.translate.batch(group.map((r) => r.content), meta);
        } catch (error) {
          if (error?.blocked) {
            counts.blocked += 1;
            console.warn('[worker] review translate blocked (' + label(batcher.name) + ', batch):', error.message);
            openCooldown(batcher, error);
            return;
          }
          if (error?.permanent) {
            batchStats.split += 1;
            const mid = Math.ceil(group.length / 2);
            await run(group.slice(0, mid));
            await run(group.slice(mid));
            return;
          }
          console.warn('[worker] review translate batch failed:', error?.message);
          return;
        }
        for (let i = 0; i < group.length; i += 1) {
          const review = group[i];
          const value = normalized(items[i]) === normalized(review.content) ? '' : items[i];
          counts.checked += 1;
          if (await record(review.id, review.contentHash, value, meta.model ? batcher.name + ':' + meta.model : batcher.name)) {
            counts.ok += 1;
            used[label(batcher.name)] += 1;
            if (meta.model) modelUsed[meta.model] = (modelUsed[meta.model] ?? 0) + 1;
            if (value) changed.add(review.slug);
          }
          leftover.delete(review.id);
        }
      };
      for (const group of packBatches(pending, { maxChars: settings.translateBatchMaxChars, maxItems: settings.translateBatchMaxItems })) {
        if (now() < stateOf(batcher.name).cooldownUntil) break;
        await run(group);
      }
      pending = pending.filter((r) => leftover.has(r.id));
      console.log('[worker] review translate batch requests=' + batchStats.requests + ' splits=' + batchStats.split + ' remaining=' + pending.length);
    }
  }

  outer:
  for (const review of pending) {
    counts.checked += 1;
    let done = false;
    const contentFailed = new Map(); // provider name -> error, for this review only
    while (!done) {
      const provider = available().find((p) => !contentFailed.has(p.name));
      if (!provider) {
        if (!contentFailed.size) break outer;
        // Every usable provider refused this review's content: back the review off, not the pass.
        counts.failed += 1;
        await recordFailure(review.id, { retryMs: settings.translateCooldownMs }).catch(() => {});
        console.warn('[worker] review translate failed for ' + review.slug + ' (content refused by ' +
          [...contentFailed.keys()].map(label).join(',') + '):', [...contentFailed.values()].at(-1)?.message);
        break;
      }
      if (lastCall[provider.name] != null && provider.delayMs > 0) {
        const wait = provider.delayMs - (now() - lastCall[provider.name]);
        if (wait > 0) await sleep(wait);
      }
      lastCall[provider.name] = now();
      try {
        const meta = {};
        const translated = String(await provider.translate(review.content, meta) ?? '').trim();
        if (!translated) throw new Error('empty translation');
        // Echoing the source (names, already Vietnamese) is stored as '' so the row leaves the queue.
        const value = normalized(translated) === normalized(review.content) ? '' : translated;
        if (await record(review.id, review.contentHash, value, meta.model ? provider.name + ':' + meta.model : provider.name)) {
          counts.ok += 1;
          used[label(provider.name)] += 1;
          if (meta.key) keyUsed[meta.key] = (keyUsed[meta.key] ?? 0) + 1;
          if (meta.model) modelUsed[meta.model] = (modelUsed[meta.model] ?? 0) + 1;
          if (value) changed.add(review.slug);
        }
        stateOf(provider.name).errors = 0;
        consecutive = 0;
        done = true;
      } catch (error) {
        if (error?.blocked) {
          counts.blocked += 1;
          console.warn('[worker] review translate blocked (' + label(provider.name) + '):', error.message);
          openCooldown(provider, error);
          continue; // same review, next provider
        }
        if (error?.permanent) {
          // Safety/recitation/truncation is about this text, not the provider: try the next one.
          contentFailed.set(provider.name, error);
          continue;
        }
        counts.failed += 1;
        consecutive += 1;
        stateOf(provider.name).errors += 1;
        await recordFailure(review.id, { retryMs: settings.translateCooldownMs }).catch(() => {});
        console.warn('[worker] review translate failed for ' + review.slug + ' (' + label(provider.name) + '):', error?.message);
        done = true;
        if (consecutive >= settings.translateMaxConsecutiveErrors) {
          state.cooldownUntil = now() + settings.translateCooldownMs;
          break outer;
        }
      }
    }
  }

  if (!available().length) {
    state.cooldownUntil = Math.max(state.cooldownUntil, Math.min(...chain.map((p) => stateOf(p.name).cooldownUntil)));
  }
  console.log('[worker] review translate checked=' + counts.checked + ' ok=' + counts.ok +
    ' failed=' + counts.failed + ' blocked=' + counts.blocked +
    ' providers=' + Object.entries(used).map(([name, n]) => name + ':' + n).join(',') +
    (Object.keys(modelUsed).length ? ' models=' + Object.entries(modelUsed).map(([id, n]) => id + ':' + n).join(',') : '') +
    (Object.keys(keyUsed).length ? ' keys=' + Object.entries(keyUsed).map(([id, n]) => id + ':' + n).join(',') : ''));
  return [...changed];
}
