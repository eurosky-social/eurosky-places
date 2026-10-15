import pg from "pg";
import { createPool, type Pool } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://places:places@127.0.0.1:5433/places_test";

// Drops and recreates the test database, then applies the migrations. Start the local
// database first: `docker compose up -d`.
export async function freshDatabase(): Promise<Pool> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`refusing to recreate database "${name}": test database names must end in _test`);
  }
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  return pool;
}
