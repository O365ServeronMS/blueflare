import assert from 'node:assert/strict';
import test from 'node:test';

// Runs only against a throwaway database (TEST_DATABASE_URL, name must contain "test").
const TEST_DB = process.env.TEST_DATABASE_URL || '';
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
const dbTest = TEST_DB && /test/i.test(new URL(TEST_DB).pathname) ? test : test.skip;

dbTest('catalog audit memory SQL: upsert refreshes decided_at, fresh honours DAYS, prune drops rows past twice DAYS', async () => {
  const { pool, migrate } = await import('../src/db.js');
  const { MEMORY_SQL } = await import('../src/catalogAudit.js');
  await migrate();
  const hashes = ['t-memory-a', 't-memory-b', 't-memory-c'];
  const cleanup = () => pool.query('DELETE FROM catalog_audit_group_memory WHERE group_hash = ANY($1)', [hashes]);
  await cleanup();
  try {
    for (const h of hashes) await pool.query(MEMORY_SQL.upsert, [h, 'key-' + h, 'none', 1]);
    await assert.rejects(pool.query(MEMORY_SQL.upsert, ['t-memory-bad', 'k', 'weird', 1]), /check/i);
    await pool.query("UPDATE catalog_audit_group_memory SET decided_at = now() - interval '30 days' WHERE group_hash = 't-memory-b'");
    await pool.query("UPDATE catalog_audit_group_memory SET decided_at = now() - interval '60 days' WHERE group_hash = 't-memory-c'");
    const fresh = async () => (await pool.query(MEMORY_SQL.fresh, [28])).rows.map((r) => r.group_hash).filter((h) => hashes.includes(h));
    assert.deepEqual(await fresh(), ['t-memory-a']);
    await pool.query(MEMORY_SQL.upsert, ['t-memory-b', 'key-b', 'blocked', 2]);
    assert.deepEqual((await fresh()).sort(), ['t-memory-a', 't-memory-b']);
    assert.equal((await pool.query("SELECT outcome, run_id::int FROM catalog_audit_group_memory WHERE group_hash='t-memory-b'")).rows[0].outcome, 'blocked');
    await pool.query(MEMORY_SQL.prune, [28]);
    const left = (await pool.query('SELECT group_hash FROM catalog_audit_group_memory WHERE group_hash = ANY($1)', [hashes])).rows.map((r) => r.group_hash).sort();
    assert.deepEqual(left, ['t-memory-a', 't-memory-b']);
  } finally {
    await cleanup();
    await pool.end();
  }
});
