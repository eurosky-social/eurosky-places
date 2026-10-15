import { readFile } from "node:fs/promises";
import { withTransaction, type Pool } from "../db.ts";

const sql = (name: string) => readFile(new URL(`./sql/${name}`, import.meta.url), "utf8");

export type BBox = readonly [xmin: number, ymin: number, xmax: number, ymax: number];

export interface Release {
  sources: Record<string, string>;
  bbox: BBox | null;
}

export const REFERENCE_TABLES = ["places", "areas", "addresses"] as const;

// Recreates schema ref_next with empty staging tables.
export async function prepareStaging(pool: Pool): Promise<void> {
  await pool.query(await sql("stage.sql"));
}

// Builds the served tables in ref_next from the staging tables, then freezes them: the
// reference data is never updated afterwards, so it never needs vacuuming again.
export async function buildReference(pool: Pool): Promise<Record<string, number>> {
  await pool.query(await sql("build.sql"));
  const counts: Record<string, number> = {};
  for (const table of REFERENCE_TABLES) {
    // VACUUM cannot run inside a transaction or a multi-statement query.
    await pool.query(`VACUUM (FREEZE, ANALYZE) ref_next.${table}`);
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ref_next.${table}`);
    counts[table] = Number(rows[0]!.n);
  }
  return counts;
}

// Makes ref_next the served schema in one transaction. The previous one is kept as
// ref_prev for rollback; the one before that is dropped. Returns whether there was a
// previous one.
export async function swapReference(pool: Pool, release: Release, counts: Record<string, number>): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query("DROP SCHEMA IF EXISTS ref_prev CASCADE");
    const hadPrevious = Boolean((await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'ref'")).rowCount);
    if (hadPrevious) await client.query("ALTER SCHEMA ref RENAME TO ref_prev");
    await client.query("ALTER SCHEMA ref_next RENAME TO ref");
    await client.query("INSERT INTO meta.releases (sources, bbox, counts) VALUES ($1, $2, $3)", [
      release.sources,
      release.bbox,
      counts,
    ]);
    return hadPrevious;
  });
}

// Puts ref_prev back in place, e.g. when a new release turns out to be broken.
export async function rollbackReference(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'ref_prev'");
    if (!rowCount) throw new Error("no previous reference data (ref_prev) to roll back to");
    await client.query("DROP SCHEMA IF EXISTS ref CASCADE");
    await client.query("ALTER SCHEMA ref_prev RENAME TO ref");
    await client.query("DELETE FROM meta.releases WHERE id = (SELECT max(id) FROM meta.releases)");
  });
}
