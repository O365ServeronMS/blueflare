const dependencyCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  '53300',
  '57P01',
  '57P02',
  '57P03'
]);

const dependencyMessages = /connection (?:terminated|reset|refused|timed out)|connection timeout|socket closed|client has encountered a connection error|database system is (?:starting up|in recovery mode)|read econreset/i;

function errorChain(error) {
  const errors = [];
  let current = error;
  while (current && errors.length < 4) {
    errors.push(current);
    current = current.cause;
  }
  return errors;
}

export function isTransientDependencyError(error) {
  return errorChain(error).some((current) => (
    dependencyCodes.has(String(current?.code || '')) ||
    dependencyMessages.test(String(current?.message || ''))
  ));
}

export function retryDelayMs(failureStreak, baseMs = 1000, maxMs = 60000) {
  const exponent = Math.min(10, Math.max(0, Number(failureStreak) - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

export function waitFor(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function timestamp(now) {
  return new Date(now()).toISOString();
}

function errorDetails(error, stage, failureStreak) {
  return {
    stage,
    failure_streak: failureStreak,
    last_failure_at: new Date().toISOString(),
    error: String(error?.message || error || 'Unknown worker failure').slice(0, 500)
  };
}

/**
 * Keep transient PostgreSQL and Valkey failures from taking down the process.
 * Programming/configuration failures still surface as a non-zero exit so
 * Compose can make them visible instead of masking a broken release.
 */
export async function runWorkerLoop(options) {
  const {
    initialize,
    runCycle,
    writeHeartbeat = async () => {},
    isTransient = isTransientDependencyError,
    intervalMs,
    retryBaseMs = 1000,
    retryMaxMs = 60000,
    now = () => Date.now(),
    sleep = waitFor,
    signal,
    logger = console
  } = options;
  let initialized = false;
  let failureStreak = 0;

  async function heartbeat(status, details = {}) {
    try {
      await writeHeartbeat(status, details);
    } catch (error) {
      logger.warn('[worker] heartbeat write failed', error.message);
    }
  }

  async function retry(error, stage) {
    failureStreak += 1;
    const delay = retryDelayMs(failureStreak, retryBaseMs, retryMaxMs);
    const details = errorDetails(error, stage, failureStreak);
    await heartbeat('degraded', details);
    logger.warn(
      '[worker] transient ' + stage + ' failure; retrying in ' + delay + 'ms',
      details.error
    );
    await sleep(delay, signal);
  }

  while (!signal?.aborted) {
    if (!initialized) {
      await heartbeat('starting', { failure_streak: failureStreak });
      try {
        await initialize();
        initialized = true;
        failureStreak = 0;
      } catch (error) {
        if (!isTransient(error)) {
          await heartbeat('failed', errorDetails(error, 'startup', failureStreak + 1));
          throw error;
        }
        await retry(error, 'startup');
        continue;
      }
    }

    const startedAt = now();
    const startedAtIso = timestamp(() => startedAt);
    await heartbeat('running', {
      last_cycle_started_at: startedAtIso,
      failure_streak: failureStreak
    });
    try {
      await runCycle();
      failureStreak = 0;
      const elapsed = Math.max(0, now() - startedAt);
      await heartbeat('ok', {
        last_cycle_started_at: startedAtIso,
        last_success_at: timestamp(now),
        last_cycle_duration_ms: elapsed,
        failure_streak: failureStreak
      });
      await sleep(Math.max(1000, intervalMs - elapsed), signal);
    } catch (error) {
      if (!isTransient(error)) {
        await heartbeat('failed', errorDetails(error, 'cycle', failureStreak + 1));
        throw error;
      }
      await retry(error, 'cycle');
    }
  }
}
