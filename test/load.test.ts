import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Pool } from "../src/db.ts";
import { extractToStaging, type SourcePaths } from "../src/load/extract.ts";
import { buildReference, prepareStaging, rollbackReference, swapReference, type BBox } from "../src/load/reference.ts";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/db.ts";

// Small local Parquet files shaped like the real sources, so the whole load runs
// offline: DuckDB extraction with the production filters, the Postgres build and the swap.
const BERLIN: BBox = [13.08, 52.33, 13.76, 52.68];

let pool: Pool;
let dir: string;
let paths: SourcePaths;

async function writeFixtures(target: string): Promise<SourcePaths> {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();
  const p = (name: string) => join(target, name);
  try {
    await con.run("INSTALL spatial; LOAD spatial");
    const bbox = (x: number, y: number) => `{'xmin': ${x}, 'xmax': ${x}, 'ymin': ${y}, 'ymax': ${y}}`;
    const overture = (id: string, name: string, cat: string, conf: number, status: string | null, sources: string[], x: number, y: number) =>
      `('${id}', {'primary': '${name}'}, '${cat}', {'primary': '${cat}', 'hierarchy': ['${cat}'], 'alternates': []::VARCHAR[]},
        ${conf}, ${status ? `'${status}'` : "NULL"}, [${sources.map((s) => `{'dataset': '${s}'}`).join(", ")}], ${bbox(x, y)})`;
    await con.run(`COPY (SELECT * FROM (VALUES
      ${overture("ov-open", "The Coffee Ape", "coffee_shop", 0.9, "open", ["meta", "Overture"], 13.4245, 52.4867)},
      ${overture("ov-closed", "Closed Bar", "bar", 0.9, "permanently_closed", ["meta", "Overture"], 13.4246, 52.4868)},
      ${overture("ov-unsure", "Maybe Shop", "shopping", 0.3, "open", ["meta", "Overture"], 13.4247, 52.4869)},
      ${overture("ov-registry", "Aspes Gmbh", "restaurant", 0.9, "open", ["BrightQuery", "Overture"], 13.4248, 52.4870)},
      ${overture("ov-munich", "Far Away", "museum", 0.9, "open", ["meta", "Overture"], 11.5755, 48.1374)},
      ${overture("ov-nostatus", "Hugendubel", "bookstore", 0.6, null, ["Foursquare", "Overture"], 13.4250, 52.4866)}
    ) AS t(id, names, basic_category, taxonomy, confidence, operating_status, sources, bbox)) TO '${p("overture-places.parquet")}'`);

    const fsq = (id: string, name: string, x: number, y: number, closed: string | null, refreshed: string, label: string, flags: string) =>
      `('${id}', '${name}', ${y}, ${x}, ${closed ? `'${closed}'` : "NULL::VARCHAR"}, '${refreshed}', ['${label}'], ${flags})`;
    await con.run(`COPY (SELECT * FROM (VALUES
      ${fsq("fsq-station", "U Hermannplatz", 13.4244, 52.4868, null, "2026-05-01", "Travel and Transportation > Transport Hub > Metro Station", "[]::VARCHAR[]")},
      ${fsq("fsq-stale", "Old Kiosk", 13.4243, 52.4869, null, "2020-01-01", "Retail > Kiosk", "[]::VARCHAR[]")},
      ${fsq("fsq-closed", "Gone Bistro", 13.4242, 52.4870, "2025-01-01", "2026-01-01", "Dining and Drinking > Bistro", "[]::VARCHAR[]")},
      ${fsq("fsq-flagged", "Dupe Café", 13.4241, 52.4871, null, "2026-01-01", "Dining and Drinking > Cafe", "['duplicate']")},
      ${fsq("fsq-noflags", "Zapfhahn", 13.4240, 52.4872, null, "2025-12-01", "Dining and Drinking > Bar > Pub", "NULL::VARCHAR[]")}
    ) AS t(fsq_place_id, name, latitude, longitude, date_closed, date_refreshed, fsq_category_labels, unresolved_flags))
    TO '${p("foursquare-places.parquet")}'`);

    // A "country" whose outline has well over 256 points, so the build has to cut it up,
    // a district inside it, and a maritime area that must be skipped.
    await con.run(`COPY (
      SELECT division_id, subtype, class, {'primary': name} AS names, country, geometry,
             {'xmin': ST_XMin(geometry), 'xmax': ST_XMax(geometry), 'ymin': ST_YMin(geometry), 'ymax': ST_YMax(geometry)} AS bbox
      FROM (VALUES
        ('div-country', 'country', 'land', 'Testland', 'DE', ST_Buffer(ST_Point(13.4, 52.5), 1.0, 300)),
        ('div-district', 'macrohood', 'land', 'Neukölln', 'DE', ST_MakeEnvelope(13.40, 52.47, 13.45, 52.49)),
        ('div-sea', 'country', 'maritime', 'Testland waters', 'DE', ST_Buffer(ST_Point(13.4, 52.5), 1.5, 8))
      ) AS t(division_id, subtype, class, name, country, geometry)
    ) TO '${p("overture-areas.parquet")}'`);

    await con.run(`COPY (SELECT * FROM (VALUES
      ('Hermannplatz', '5', '10967', ${bbox(13.4246, 52.4869)}),
      (NULL, '7', '10967', ${bbox(13.4247, 52.4869)})
    ) AS t(street, number, postcode, bbox)) TO '${p("overture-addresses.parquet")}'`);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
  return {
    overturePlaces: p("overture-places.parquet"),
    foursquarePlaces: p("foursquare-places.parquet"),
    overtureAreas: p("overture-areas.parquet"),
    overtureAddresses: p("overture-addresses.parquet"),
  };
}

async function load(sources: Record<string, string>) {
  await prepareStaging(pool);
  const extracted = await extractToStaging({
    databaseUrl: TEST_DATABASE_URL,
    paths,
    foursquareCutoff: "2024-09-15",
    bbox: BERLIN,
  });
  const counts = await buildReference(pool);
  const hadPrevious = await swapReference(pool, { sources, bbox: BERLIN }, counts);
  return { extracted, counts, hadPrevious };
}

before(async () => {
  pool = await freshDatabase();
  dir = await mkdtemp(join(tmpdir(), "eurosky-places-"));
  paths = await writeFixtures(dir);
});

after(async () => {
  await pool?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a load keeps only current, confirmed venues inside the area", async () => {
  await pool.query(
    "INSERT INTO live.checkins (uri, place_key, created_at) VALUES ('at://did:plc:test/x/1', 'urn:atgeo:foursquare.com:place:fsq-station', now())",
  );
  const { extracted, counts, hadPrevious } = await load({ overture: "fixture-1", foursquare: "fixture-1" });

  assert.equal(hadPrevious, false);
  assert.deepEqual(extracted, { overture_places: 2, foursquare_places: 2, areas: 2, addresses: 1 });
  const { rows } = await pool.query("SELECT origin, name, category, category_group FROM ref.places ORDER BY origin");
  assert.deepEqual(rows, [
    { origin: "urn:atgeo:foursquare.com:place:fsq-noflags", name: "Zapfhahn", category: "Pub", category_group: "food_drink" },
    { origin: "urn:atgeo:foursquare.com:place:fsq-station", name: "U Hermannplatz", category: "Metro Station", category_group: "transit" },
    { origin: "urn:atgeo:overturemaps.org:place:ov-nostatus", name: "Hugendubel", category: "bookstore", category_group: "shopping" },
    { origin: "urn:atgeo:overturemaps.org:place:ov-open", name: "The Coffee Ape", category: "coffee_shop", category_group: "food_drink" },
  ]);
  assert.equal(counts.places, 4);
  assert.equal(counts.divisions, 2);
  assert.equal(counts.addresses, 1);
  // Live data is not touched by a load.
  const live = await pool.query("SELECT count(*)::int AS n FROM live.checkins");
  assert.equal(live.rows[0].n, 1);
});

test("large boundary outlines are cut into pieces that still answer point lookups", async () => {
  const pieces = await pool.query(
    `SELECT d.name, count(*)::int AS n, max(ST_NPoints(a.geom)) AS max_points
     FROM ref.areas a JOIN ref.divisions d USING (origin) GROUP BY d.name ORDER BY d.name`,
  );
  const byName = Object.fromEntries(pieces.rows.map((r) => [r.name, r]));
  assert.ok(byName["Testland"].n > 1, "the 1200-point outline should be split");
  assert.ok(byName["Testland"].max_points <= 256 + 1);
  assert.equal(byName["Testland waters"], undefined, "maritime areas are skipped");

  const hermannplatz = await pool.query(
    `SELECT DISTINCT d.origin, d.subtype, d.name FROM ref.areas a JOIN ref.divisions d USING (origin)
     WHERE ST_Covers(a.geom, ST_SetSRID(ST_MakePoint(13.4245, 52.4867), 4326)) ORDER BY d.subtype`,
  );
  assert.deepEqual(hermannplatz.rows, [
    { origin: "urn:atgeo:overturemaps.org:division:div-country", subtype: "country", name: "Testland" },
    { origin: "urn:atgeo:overturemaps.org:division:div-district", subtype: "macrohood", name: "Neukölln" },
  ]);
});

test("each area gets its size and a point inside it", async () => {
  const { rows } = await pool.query(
    `SELECT name, area_m2, ST_Covers(s.geom, d.point::geometry) AS inside
     FROM ref.divisions d
     CROSS JOIN LATERAL (SELECT ST_Union(geom) AS geom FROM ref.areas a WHERE a.origin = d.origin) s
     ORDER BY area_m2`,
  );
  assert.deepEqual(rows.map((r) => r.name), ["Neukölln", "Testland"]);
  assert.ok(rows.every((r) => r.inside), "every representative point lies inside its area");
  // ~0.05° × 0.02° near Berlin is roughly 3.4 km × 2.2 km.
  assert.ok(rows[0].area_m2 > 6e6 && rows[0].area_m2 < 9e6);
});

test("a second load keeps the previous one for rollback", async () => {
  assert.equal((await load({ overture: "fixture-2", foursquare: "fixture-2" })).hadPrevious, true);
  const schemas = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ref%' ORDER BY nspname");
  assert.deepEqual(schemas.rows.map((r) => r.nspname), ["ref", "ref_prev"]);
  const latest = await pool.query("SELECT sources, bbox, counts FROM meta.releases ORDER BY id DESC LIMIT 1");
  assert.deepEqual(latest.rows[0].sources, { overture: "fixture-2", foursquare: "fixture-2" });
  assert.deepEqual(latest.rows[0].bbox, [...BERLIN]);
  assert.equal(latest.rows[0].counts.places, 4);

  await rollbackReference(pool);
  const after = await pool.query("SELECT sources FROM meta.releases ORDER BY id DESC LIMIT 1");
  assert.deepEqual(after.rows[0].sources, { overture: "fixture-1", foursquare: "fixture-1" });
  const remaining = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ref%'");
  assert.deepEqual(remaining.rows.map((r) => r.nspname), ["ref"]);
  await assert.rejects(rollbackReference(pool), /no previous reference data/);
});

test("a source with duplicate IDs fails the load and leaves the served data alone", async () => {
  await prepareStaging(pool);
  await pool.query(`INSERT INTO ref_next.stage_places (dataset, collection, id, name, category_group, lon, lat)
                    VALUES ('foursquare.com', 'place', 'dup', 'A', 'other', 13.4, 52.5),
                           ('foursquare.com', 'place', 'dup', 'B', 'other', 13.5, 52.5)`);
  await assert.rejects(buildReference(pool), /could not create unique index|duplicate key/);
  const served = await pool.query("SELECT count(*)::int AS n FROM ref.places");
  assert.equal(served.rows[0].n, 4);
});
