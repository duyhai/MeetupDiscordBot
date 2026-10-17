import { randomUUID } from 'node:crypto';

import pg from 'pg';

/**
 * Points DATABASE_URL at a fresh schema (search_path in the connection
 * string), so a file that writes report_snapshots cannot race the files
 * that TRUNCATE it. Call before any repository creates its pool; `drop`
 * restores DATABASE_URL and drops the schema.
 */
export async function useIsolatedSchema(
  prefix: string,
): Promise<{ drop(): Promise<void> }> {
  const original = process.env.DATABASE_URL ?? '';
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: original });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const separator = original.includes('?') ? '&' : '?';
  process.env.DATABASE_URL = `${original}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  return {
    drop: async () => {
      process.env.DATABASE_URL = original;
      const cleanup = new pg.Client({ connectionString: original });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
