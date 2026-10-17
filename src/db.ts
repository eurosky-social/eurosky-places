import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

// A suggestion runs three queries in parallel and then one more, so a handful of
// concurrent requests already needs more than pg's default of 10 connections.
export function createPool(connectionString: string, max = Number(process.env.PG_POOL_MAX ?? 20)): Pool {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
