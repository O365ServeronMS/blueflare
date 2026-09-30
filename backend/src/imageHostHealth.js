// Định danh kết quả một lần thăm dò URL ảnh: ok | gone (mất thật) | transient (chưa kết luận được).
const GONE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED']);

export function classifyProbe({ status, error } = {}) {
  if (status) {
    if (status >= 200 && status < 400) return 'ok';
    if (status === 404 || status === 410) return 'gone';
    return 'transient';
  }
  const code = error?.cause?.code || error?.code;
  return GONE_CODES.has(code) ? 'gone' : 'transient';
}

// Host chỉ bị coi là chết khi mọi mẫu đều "gone"; một mẫu ok là đủ để sống.
export function judgeSamples(outcomes) {
  if (!outcomes.length) return 'unknown';
  if (outcomes.includes('ok')) return 'alive';
  return outcomes.every((outcome) => outcome === 'gone') ? 'dead' : 'unknown';
}

export function nextHostState(previous, verdict, { deadAfter, now = new Date() }) {
  const prior = previous || { status: 'alive', consecutive_failures: 0, last_ok_at: null, dead_since: null };
  if (verdict === 'alive') {
    return { status: 'alive', consecutive_failures: 0, last_ok_at: now, dead_since: null };
  }
  if (verdict === 'unknown') return { ...prior };
  const failures = prior.consecutive_failures + 1;
  const dead = prior.status === 'dead' || failures >= deadAfter;
  return {
    status: dead ? 'dead' : 'alive',
    consecutive_failures: failures,
    last_ok_at: prior.last_ok_at,
    dead_since: dead ? (prior.dead_since || now) : null
  };
}

export async function probeUrl(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'BlueflareImageCache/1.0', range: 'bytes=0-0' },
      signal: controller.signal
    });
    await response.body?.cancel().catch(() => {});
    return classifyProbe({ status: response.status });
  } catch (error) {
    return classifyProbe({ error });
  } finally {
    clearTimeout(timer);
  }
}
