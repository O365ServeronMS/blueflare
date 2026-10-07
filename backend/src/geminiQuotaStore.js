/** PostgreSQL side of geminiQuotaLedger.js (table gemini_quota_ledger, migration 031). Holds fingerprints, never keys. */

const KEEP_DAYS = 30;

export function createPgQuotaStore(options = {}) {
  const getPool = options.getPool ?? (async () => (await import('./db.js')).pool);
  return {
    async loadDay(day) {
      const pool = await getPool();
      const result = await pool.query(
        'SELECT key_fp, model, day::text AS day, requests, successes, failures, tokens, recent_tokens, ' +
        '(extract(epoch FROM last_request_at) * 1000)::bigint AS last_request_ms ' +
        'FROM gemini_quota_ledger WHERE day = $1::date',
        [day]
      );
      return result.rows.map((row) => ({
        keyFp: row.key_fp, model: row.model, day: row.day, requests: row.requests, successes: row.successes,
        failures: row.failures, tokens: Number(row.tokens), recent: Array.isArray(row.recent_tokens) ? row.recent_tokens : [],
        lastRequestAt: row.last_request_ms == null ? null : Number(row.last_request_ms)
      }));
    },
    async save(row) {
      const pool = await getPool();
      await pool.query(
        'INSERT INTO gemini_quota_ledger (key_fp, model, day, requests, successes, failures, tokens, recent_tokens, last_request_at, updated_at) ' +
        'VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::jsonb, CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9::bigint / 1000.0) END, now()) ' +
        'ON CONFLICT (key_fp, model, day) DO UPDATE SET requests = EXCLUDED.requests, successes = EXCLUDED.successes, ' +
        'failures = EXCLUDED.failures, tokens = EXCLUDED.tokens, recent_tokens = EXCLUDED.recent_tokens, ' +
        'last_request_at = EXCLUDED.last_request_at, updated_at = now()',
        [row.keyFp, row.model, row.day, row.requests, row.successes, row.failures, row.tokens, JSON.stringify(row.recent), row.lastRequestAt]
      );
    },
    async prune(day) {
      const pool = await getPool();
      await pool.query("DELETE FROM gemini_quota_ledger WHERE day < $1::date - $2::int", [day, KEEP_DAYS]);
    }
  };
}
