import { readdir, readFile } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { createPool, withTransaction, type Pool } from "./db.ts";

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);

// Applies db/migrations/*.sql in name order, each in its own transaction, and records
// them in meta.schema_migrations. These cover the long-lived schemas (meta, live); the
// reference schema is rebuilt from scratch by every data load instead.
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query("CREATE SCHEMA IF NOT EXISTS meta");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS meta.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set(
    (await pool.query<{ version: string }>("SELECT version FROM meta.schema_migrations")).rows.map((r) => r.version),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (done.has(version)) continue;
    const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO meta.schema_migrations (version) VALUES ($1)", [version]);
    });
    applied.push(version);
  }
  return applied;
}

if (import.meta.main) {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } finally {
    await pool.end();
  }
}
