import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (error) => {
  console.error('[postgres] idle client error', error);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '../migrations');

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [742019]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const appliedResult = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedResult.rows.map((row) => row.name));
    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [name]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [742019]).catch(() => {});
    client.release();
  }
}

export async function postgresHealth() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - started };
}

export async function closeDatabase() {
  await pool.end();
}
