const liveStatuses = new Set(['starting', 'running', 'ok', 'degraded']);

export const workerHeartbeatKey = 'catalog:worker:heartbeat';

export function workerHeartbeatTtlSeconds(syncIntervalMs) {
  return Math.max(60, Math.ceil(((syncIntervalMs * 2) + (5 * 60 * 1000)) / 1000));
}

export function createWorkerHeartbeat(status, details = {}, now = Date.now()) {
  return {
    ...details,
    status: String(status),
    updated_at: new Date(now).toISOString()
  };
}

export function parseWorkerHeartbeat(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function assessWorkerHeartbeat(heartbeat, maximumAgeMs, now = Date.now()) {
  if (!heartbeat) return { ok: false, reason: 'missing' };
  const updatedAt = Date.parse(heartbeat.updated_at || '');
  if (!Number.isFinite(updatedAt)) return { ok: false, reason: 'invalid' };
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs > maximumAgeMs) return { ok: false, reason: 'stale', ageMs };
  if (!liveStatuses.has(heartbeat.status)) {
    return { ok: false, reason: heartbeat.status || 'invalid-status', ageMs };
  }
  return { ok: true, ageMs };
}
