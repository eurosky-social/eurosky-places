import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

// A suggestion runs three queries in parallel and then one more, so a handful of
// concurrent requests already needs more than pg's default of 10 connections.
export function createPool(connectionString: string, max = Number(process.env.PG_POOL_MAX ?? 20)): Pool {
  // No parallel workers: every query here is small and request-sized, and starting
  // workers cost more than they saved (type-ahead's nearby query: ~30 ms of a ~40 ms query).
  // Typo search's trigram index (`%`) leaves out names less similar than this; it matches
  // APPROXIMATE_MIN_SIMILARITY in src/search.ts (a test checks).
  return new pg.Pool({
    connectionString,
    max,
    options: "-c max_parallel_workers_per_gather=0 -c pg_trgm.similarity_threshold=0.4",
  });
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
