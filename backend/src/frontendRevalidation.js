import { config } from './config.js';

export const FRONTEND_REVALIDATE_TAG_LIMIT = 32;

const TAG_PATTERN = /^[a-z0-9:_-]{1,128}$/;

function validTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : [])
    .filter((tag) => typeof tag === 'string' && TAG_PATTERN.test(tag)))];
}

function sameTags(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((tag, index) => tag === expected[index]);
}

/**
 * Revalidate every generated Next cache tag without exceeding the frontend's
 * per-request guard. Failures are isolated per batch so a temporarily
 * unavailable frontend never terminates the provider sync cycle.
 */
export async function revalidateFrontend(tags, options = {}) {
  const normalized = validTags(tags);
  const secret = String((options.secret ?? config.frontendRevalidateSecret) || '');
  const url = String((options.url ?? config.frontendRevalidateUrl) || '');
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? config.revalidateTimeoutMs));
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const batches = [];
  for (let index = 0; index < normalized.length; index += FRONTEND_REVALIDATE_TAG_LIMIT) {
    batches.push(normalized.slice(index, index + FRONTEND_REVALIDATE_TAG_LIMIT));
  }

  const stats = {
    tags: normalized.length,
    batches: batches.length,
    succeeded: 0,
    failed: 0,
    declined: null
  };
  if (!normalized.length) {
    stats.declined = 'empty';
    return stats;
  }
  if (!secret || !url) {
    stats.declined = 'not-configured';
    return stats;
  }

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-blueflare-revalidate': secret
        },
        body: JSON.stringify({ tags: batch }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        stats.failed += 1;
        logger.warn(
          '[worker] frontend revalidation failed batch=' + (index + 1) + '/' + batches.length +
          ' status=' + response.status
        );
        continue;
      }
      const payload = await response.json().catch(() => null);
      if (payload?.ok !== true || !sameTags(payload.tags, batch)) {
        stats.failed += 1;
        logger.warn(
          '[worker] frontend revalidation response mismatch batch=' +
          (index + 1) + '/' + batches.length
        );
        continue;
      }
      stats.succeeded += 1;
    } catch (error) {
      stats.failed += 1;
      logger.warn(
        '[worker] frontend revalidation unavailable batch=' +
        (index + 1) + '/' + batches.length,
        error?.message || error
      );
    }
  }
  return stats;
}
