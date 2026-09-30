/**
 * Pure decision logic for reporting watch progress (PUT /api/me/progress).
 * The browser wiring lives in components/useProgressReporter.ts.
 */

export const REPORT_INTERVAL_SEC = 15;
export const MIN_POSITION_SEC = 1;

export type ProgressPayload = {
  slug: string;
  episodeKey: string;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
};

type Sample = { position: number; duration: number };

/** Null for anything the server would reject or that is not worth storing (live, < 1s). */
export function buildProgressPayload(input: {
  slug: string;
  episodeKey: string;
  position: number;
  duration: number;
  now: number;
}): ProgressPayload | null {
  const { slug, episodeKey, position, duration, now } = input;
  if (!slug || !episodeKey) return null;
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return null;
  if (duration < 1 || position < MIN_POSITION_SEC) return null;
  const durationSec = Math.round(duration);
  return {
    slug,
    episodeKey,
    positionSec: Math.min(durationSec, Math.round(position)),
    durationSec,
    updatedAt: now,
  };
}

export type ProgressReporter = {
  /** Feed a `timeupdate` sample; sends only after intervalSec of playback movement. */
  tick(position: number, duration: number): void;
  /** Send the latest sample now if it differs from what was last sent. */
  flush(): void;
  /** Flush once and ignore any later input. */
  dispose(): void;
};

export function createProgressReporter(options: {
  slug: string;
  episodeKey: string;
  send: (payload: ProgressPayload) => unknown;
  now?: () => number;
  intervalSec?: number;
}): ProgressReporter {
  const { slug, episodeKey, send, now = Date.now, intervalSec = REPORT_INTERVAL_SEC } = options;
  let latest: Sample | null = null;
  let lastSent: { positionSec: number; durationSec: number } | null = null;
  let baseline: number | null = null;
  let inFlight = false;
  let queued = false;
  let disposed = false;

  function dispatch() {
    if (inFlight) {
      queued = true;
      return;
    }
    if (!latest) return;
    const payload = buildProgressPayload({ slug, episodeKey, position: latest.position, duration: latest.duration, now: now() });
    if (!payload) return;
    if (lastSent && lastSent.positionSec === payload.positionSec && lastSent.durationSec === payload.durationSec) return;
    inFlight = true;
    lastSent = { positionSec: payload.positionSec, durationSec: payload.durationSec };
    baseline = latest.position;
    // Failures are dropped on purpose: the next interval or flush carries newer data.
    new Promise((resolve) => resolve(send(payload)))
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          dispatch();
        }
      });
  }

  return {
    tick(position, duration) {
      if (disposed) return;
      if (!Number.isFinite(position) || !Number.isFinite(duration) || duration < 1) {
        latest = null; // live or not-yet-known duration: nothing to report
        return;
      }
      latest = { position, duration };
      if (baseline === null) baseline = position;
      if (Math.abs(position - baseline) >= intervalSec) dispatch();
    },
    flush() {
      if (!disposed) dispatch();
    },
    dispose() {
      if (disposed) return;
      dispatch();
      disposed = true;
    },
  };
}

export function putProgress(payload: ProgressPayload) {
  return fetch("/api/me/progress", {
    method: "PUT",
    keepalive: true,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
