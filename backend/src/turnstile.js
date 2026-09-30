const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_MAX = 2048;

// Returns { ok: true } | { ok: false } | { ok: false, unavailable: true }.
export function createTurnstileVerifier({ secret = process.env.TURNSTILE_SECRET_KEY, fetchImpl = fetch, timeoutMs = 4000, logger = console } = {}) {
  const enabled = Boolean(secret && secret.trim());
  async function verify(token, remoteIp) {
    if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return { ok: false };
    try {
      const response = await fetchImpl(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, response: token, ...(remoteIp && remoteIp !== 'unknown' ? { remoteip: remoteIp } : {}) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error('siteverify ' + response.status);
      const result = await response.json();
      return { ok: result?.success === true };
    } catch (error) {
      logger.warn?.('[api] turnstile siteverify unavailable', error.message);
      return { ok: false, unavailable: true };
    }
  }
  return { enabled, verify };
}
