// Thin Postgres client shared by apps/api and apps/ingestion, so connection
// config and pool settings live in exactly one place. Schema lives in
// migrations/001_init.sql, which mirrors docs/Database.md §6.

import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env and point it at " +
          "a Postgres instance with the TimescaleDB extension available."
      );
    }
    // PG_POOL_MAX caps connections per process. The serverless API runs many
    // short-lived instances against Supabase's transaction pooler, so it sets
    // a small cap there; everything else keeps node-postgres' default (10).
    const max = process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : undefined;
    pool = new Pool({ connectionString, ...(max && max > 0 ? { max } : {}) });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
