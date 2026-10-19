import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Pool } from "../src/db.ts";
import { freshDatabase } from "./helpers/db.ts";

// The grid (db/migrations/004_grid.sql) partitions the type-ahead indexes by place: a
// search only looks in the cells places_cells() returns, so a place in any other cell is
// never found. These check that no place within the radius can be in a cell it leaves out.

let pool: Pool;

before(async () => {
  pool = await freshDatabase();
});

after(async () => {
  await pool?.end();
});

// Points at random distances (up to the radius) and directions from each centre, measured
// on the spheroid (ST_Project); search measures on the sphere, which differs by < 0.5%.
async function missed(centres: string, radius: number, perDegree: number): Promise<{ checked: number; missed: number }> {
  const { rows } = await pool.query(
    `WITH centres AS (${centres}),
     targets AS (
       SELECT c.lng, c.lat, ST_Project(ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
                                       $1 * (0.5 + 0.5 * (s % 1000) / 999.0), radians((s * 37) % 360)) AS t
       FROM centres c CROSS JOIN generate_series(0, 199) s
     )
     SELECT count(*)::int AS checked,
            count(*) FILTER (WHERE NOT places_cell(ST_X(t::geometry), ST_Y(t::geometry), $2)
                                   = ANY(places_cells(lng, lat, $1, $2)))::int AS missed
     FROM targets`,
    [radius, perDegree],
  );
  return rows[0];
}

const spread = `SELECT (i * 7.31) % 360 - 180 AS lng, (i * 3.17) % 170 - 85 AS lat FROM generate_series(0, 199) i`;

test("every point within the radius is in one of the cells searched", async () => {
  for (const [radius, perDegree] of [[1000, 50], [2000, 50], [50_000, 2]] as const) {
    const result = await missed(spread, radius, perDegree);
    assert.equal(result.missed, 0, `${radius} m, ${perDegree} per degree: ${JSON.stringify(result)}`);
  }
});

test("the antimeridian and the poles are covered too", async () => {
  const edges = `SELECT * FROM (VALUES (179.995, 10.0), (-179.995, -10.0), (180.0, 0.0), (-180.0, 0.0),
                                       (0.0, 89.99), (120.0, -89.995), (0.0, 90.0), (45.0, -90.0), (18.95, 69.65)) v(lng, lat)`;
  for (const [radius, perDegree] of [[2000, 50], [50_000, 2]] as const) {
    const result = await missed(edges, radius, perDegree);
    assert.equal(result.missed, 0, `${radius} m: ${JSON.stringify(result)}`);
  }
});

test("a search looks in a handful of cells, near the equator and the poles alike", async () => {
  const { rows } = await pool.query(
    `SELECT lat, cardinality(places_cells(13.4, lat, 2000, 50)) AS cells
     FROM unnest(ARRAY[0, 35.66, 52.49, 69.65, 80, 89.99]::float8[]) AS lat`,
  );
  for (const r of rows) assert.ok(r.cells >= 1 && r.cells <= 30, `latitude ${r.lat}: ${r.cells} cells`);
  assert.ok(rows.filter((r) => Math.abs(r.lat) <= 70).every((r) => r.cells <= 9), JSON.stringify(rows));
});

test("places_cell is inlined, so a worldwide load does not call a function per place", async () => {
  // A SQL function call costs ~35 µs per row: over an hour for the world's places.
  const { rows } = await pool.query(
    "EXPLAIN (VERBOSE, COSTS OFF) SELECT places_cell(x, y, 50) FROM (VALUES (13.4, 52.5)) v(x, y)",
  );
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert.ok(!plan.includes("places_cell("), plan);
});
