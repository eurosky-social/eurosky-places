import type { Pool } from "../db.ts";

// What every request reads, warmed right after a swap so the first requests after a load
// do not each wait on the disk: the type-ahead tables and the area lookup go into
// Postgres's shared buffers (~7–8 GB worldwide), the spatial indexes of places and streets
// into the OS page cache (~14 GB). Cold, a search was ~3× slower than warm on the
// production host.
export const PREWARM: ReadonlyArray<{ relation: string; mode: "buffer" | "read" }> = [
  ...[
    "search_names",
    "search_names_term_idx",
    "search_names_prefix2_idx",
    "search_names_prefix3_idx",
    "search_names_cell_idx",
    "search_names_trgm_idx",
    "places_name_idx",
    "areas_geom_idx",
    "divisions",
    "divisions_pkey",
  ].map((name) => ({ relation: `ref.${name}`, mode: "buffer" as const })),
  ...["places_geog_idx", "streets_geog_idx"].map((name) => ({ relation: `ref.${name}`, mode: "read" as const })),
];

// Needs the pg_prewarm extension, which only a superuser can create (the production host's
// setup does). Returns the bytes read, or null when the extension is missing.
export async function prewarm(pool: Pool): Promise<number | null> {
  const installed = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_prewarm'");
  if (!installed.rowCount) return null;
  let blocks = 0;
  for (const { relation, mode } of PREWARM) {
    const { rows } = await pool.query<{ blocks: string }>("SELECT pg_prewarm($1::regclass, $2) AS blocks", [
      relation,
      mode,
    ]);
    blocks += Number(rows[0]!.blocks);
  }
  const { rows } = await pool.query<{ size: string }>("SELECT current_setting('block_size') AS size");
  return blocks * Number(rows[0]!.size);
}
