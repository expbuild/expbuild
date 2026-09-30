import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
}

export async function transaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function migrate(pool: pg.Pool) {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(directory)).filter(x => /^\d+_.*\.sql$/.test(x)).sort();
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(73942101)");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of files) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}
