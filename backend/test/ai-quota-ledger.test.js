import assert from 'node:assert/strict';
import test from 'node:test';

// DB tests need a throwaway database: TEST_DATABASE_URL (name must contain "test"). db.js reads
// DATABASE_URL at import time, so it is set before anything is imported.
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

const { createMemoryQuotaStore, createQuotaLedger } = await import('../src/aiQuotaLedger.js');
const { createPgQuotaStore } = await import('../src/aiQuotaStore.js');
const { utcDay, nextUtcMidnight, scopedFingerprint, parseOpenRouterModels } = await import('../src/openrouter.js');

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0); 
const clock = (start = T0) => { const c = { t: start }; c.now = () => c.t; return c; };
const limits = { rpm: 5, rpd: 3, tpm: 10000 };

test('utcDay follows UTC midnight', () => {
  assert.equal(utcDay(Date.UTC(2026, 9, 7, 23, 59, 59)), '2026-10-07');
  assert.equal(utcDay(Date.UTC(2026, 9, 8, 0, 0, 0)), '2026-10-08');
  assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 7, 12, 0, 0)), Date.UTC(2026, 9, 8));
});

test('scopedFingerprint is 12 hex of a hash, differs per scope, and is not the key', () => {
  const fp = scopedFingerprint('sk-or-secret-key', 'translate');
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.ok(!'sk-or-secret-key'.includes(fp));
  assert.notEqual(fp, scopedFingerprint('sk-or-secret-key', 'tmdb-match'));
});

test('models accept id:rpm:rpd, rpd only when given', () => {
  assert.deepEqual(parseOpenRouterModels('a/x:free:5:20,b/y:7'), [{ id: 'a/x:free', rpm: 5, rpd: 20 }, { id: 'b/y', rpm: 7 }]);
});

test('RPD: every started request counts, failures included; the pair closes at the limit until UTC midnight', async () => {
  const c = clock();
  const ledger = createQuotaLedger({ store: createMemoryQuotaStore(), now: c.now });
  await ledger.ready();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(ledger.availability('k', 'm', limits, c.t).ok, true);
    const h = await ledger.begin('k', 'm', 100, c.t);
    await ledger.finish(h, { ok: i === 0 }); // two of three fail
    c.t += 20000;
  }
  const closed = ledger.availability('k', 'm', limits, c.t);
  assert.deepEqual([closed.ok, closed.reason, closed.until], [false, 'rpd', nextUtcMidnight(c.t)]);
  assert.deepEqual(ledger.snapshot('k', 'm', c.t), { requests: 3, successes: 1, failures: 2, tokens: 0, lastRequestAt: T0 + 40000 });
  assert.equal(ledger.availability('k', 'other', limits, c.t).ok, true, 'other model unaffected');
  assert.equal(ledger.availability('k2', 'm', limits, c.t).ok, true, 'other key unaffected');
});

test('a daily-quota answer from the provider syncs the counter to the limit', async () => {
  const c = clock();
  const ledger = createQuotaLedger({ store: createMemoryQuotaStore(), now: c.now });
  await ledger.ready();
  await ledger.begin('k', 'm', 1, c.t);
  await ledger.exhaust('k', 'm', 20, c.t);
  assert.equal(ledger.snapshot('k', 'm', c.t).requests, 20);
  await ledger.exhaust('k', 'm', 5, c.t);
  assert.equal(ledger.snapshot('k', 'm', c.t).requests, 20, 'never lowers');
});

test('TPM: sliding 60s window of tokens, real counts replace estimates, headroom returns when stamps age out', async () => {
  const c = clock();
  const ledger = createQuotaLedger({ store: createMemoryQuotaStore(), now: c.now });
  await ledger.ready();
  const wide = { rpm: 5, rpd: 100, tpm: 10000 };
  const a = await ledger.begin('k', 'm', 9000, c.t); // estimate
  await ledger.finish(a, { ok: true, tokens: 4000, totalTokens: 4100 });
  c.t += 15000;
  assert.equal(ledger.availability('k', 'm', wide, c.t, 5000).ok, true, 'real 4000 + 5000 fits');
  const b = await ledger.begin('k', 'm', 5000, c.t);
  await ledger.finish(b, { ok: true, tokens: 5000 });
  c.t += 15000;
  const full = ledger.availability('k', 'm', wide, c.t, 2000);
  assert.deepEqual([full.ok, full.reason], [false, 'tpm']);
  assert.equal(full.until, T0 + 60000, 'free again when the first stamp leaves the window');
  c.t = T0 + 60001;
  assert.equal(ledger.availability('k', 'm', wide, c.t, 2000).ok, true);
  assert.equal(ledger.snapshot('k', 'm', c.t).tokens, 4100 + 5000);
});

test('RPM spacing comes from the persisted last request', async () => {
  const c = clock();
  const ledger = createQuotaLedger({ store: createMemoryQuotaStore(), now: c.now });
  await ledger.ready();
  assert.equal(ledger.availability('k', 'm', limits, c.t).rpmAt, 0);
  await ledger.begin('k', 'm', 1, c.t);
  assert.equal(ledger.availability('k', 'm', limits, c.t).rpmAt, c.t + 12000 + 250);
});

test('restart: a new ledger over the same store keeps the count, spacing and token window', async () => {
  const c = clock();
  const store = createMemoryQuotaStore();
  const first = createQuotaLedger({ store, now: c.now });
  await first.ready();
  for (let i = 0; i < 3; i += 1) await first.begin('k', 'm', 3000, c.t + i);
  const second = createQuotaLedger({ store, now: c.now });
  await second.ready();
  assert.equal(second.snapshot('k', 'm', c.t).requests, 3);
  const check = second.availability('k', 'm', limits, c.t + 10, 100);
  assert.deepEqual([check.ok, check.reason], [false, 'rpd']);
  const spacing = second.availability('k', 'm', { rpm: 5, rpd: 99, tpm: 100000 }, c.t + 10);
  assert.equal(spacing.rpmAt, c.t + 2 + 12250);
});

test('UTC day change: yesterday does not count, the old row stays in the store', async () => {
  const c = clock(Date.UTC(2026, 9, 7, 23, 59, 0));
  const store = createMemoryQuotaStore();
  const ledger = createQuotaLedger({ store, now: c.now });
  await ledger.ready();
  for (let i = 0; i < 3; i += 1) await ledger.begin('k', 'm', 1, c.t);
  assert.equal(ledger.availability('k', 'm', limits, c.t).ok, false);
  c.t = Date.UTC(2026, 9, 8, 0, 0, 1);
  await ledger.ready();
  assert.equal(ledger.availability('k', 'm', limits, c.t).ok, true);
  assert.equal(ledger.snapshot('k', 'm', c.t).requests, 0);
  assert.deepEqual([...store.rows.values()].map((r) => [r.day, r.requests]), [['2026-10-07', 3]]);
  // a restart right after midnight also starts at zero
  const restarted = createQuotaLedger({ store, now: c.now });
  await restarted.ready();
  assert.equal(restarted.availability('k', 'm', limits, c.t).ok, true);
});

test('a failing store is logged and the ledger keeps counting in memory', async () => {
  const warns = [];
  const store = { async loadDay() { throw new Error('db down'); }, async save() { throw new Error('db down'); } };
  const c = clock();
  const ledger = createQuotaLedger({ store, now: c.now, warn: (m) => warns.push(m) });
  await ledger.ready();
  await ledger.begin('k', 'm', 1, c.t);
  assert.equal(ledger.snapshot('k', 'm', c.t).requests, 1);
  assert.equal(warns.length, 2);
});

test('PG store: statements carry the fingerprint, day and window only; no key material', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const store = createPgQuotaStore({ getPool: async () => pool });
  await store.save({ keyFp: 'abc123abc123', model: 'm', day: '2026-10-07', requests: 2, successes: 1, failures: 1, tokens: 5, recent: [[T0, 7]], lastRequestAt: T0 });
  assert.match(calls[0].sql, /INSERT INTO ai_quota_ledger/);
  assert.match(calls[0].sql, /ON CONFLICT \(key_fp, model, day\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ['abc123abc123', 'm', '2026-10-07', 2, 1, 1, 5, '[[1791374400000,7]]', T0]);
  assert.equal(Math.max(...[...calls[0].sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))), calls[0].params.length);
  await store.loadDay('2026-10-07');
  assert.deepEqual(calls[1].params, ['2026-10-07']);
});

dbTest('PG store round trip survives a restart (real database)', async () => {
  const { pool, migrate } = await import('../src/db.js');
  await migrate();
  await pool.query('DELETE FROM ai_quota_ledger');
  const c = clock();
  const store = createPgQuotaStore();
  const first = createQuotaLedger({ store, now: c.now });
  await first.ready();
  const h = await first.begin('fp0123456789', 'model-x', 1234, c.t);
  await first.finish(h, { ok: true, tokens: 1000, totalTokens: 1200 });
  await first.begin('fp0123456789', 'model-x', 10, c.t + 5);
  await first.flush();
  const second = createQuotaLedger({ store: createPgQuotaStore(), now: c.now });
  await second.ready();
  assert.deepEqual(second.snapshot('fp0123456789', 'model-x', c.t), { requests: 2, successes: 1, failures: 0, tokens: 1200, lastRequestAt: c.t + 5 });
  const limited = second.availability('fp0123456789', 'model-x', { rpm: 5, rpd: 2, tpm: 100000 }, c.t + 10);
  assert.equal(limited.reason, 'rpd');
  await pool.query('DELETE FROM ai_quota_ledger');
  await pool.end();
});
