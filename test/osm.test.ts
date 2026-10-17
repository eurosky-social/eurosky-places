import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { Pool } from "../src/db.ts";
import { importOsm, OSM_FILTER_KEYS, OSM_STYLE } from "../src/load/osm.ts";
import { buildReference, prepareStaging, swapReference } from "../src/load/reference.ts";
import { categoryGroup } from "../src/places/categories.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/db.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/neukoelln-mini.osm", import.meta.url));
const installed = (binary: string) => spawnSync(binary, ["--version"]).status === 0;
const missing = [process.env.OSM2PGSQL ?? "osm2pgsql", process.env.OSMIUM ?? "osmium"].filter((b) => !installed(b));
const skip = missing.length ? `not installed: ${missing.join(", ")}` : false;
const osm = (type: string, id: number) => `urn:atgeo:openstreetmap.org:${type}:${id}`;

let pool: Pool;

before(async () => {
  pool = await freshDatabase();
});

after(async () => {
  await pool?.end();
});

test("the Postgres category function gives the same groups as categoryGroup", async () => {
  await prepareStaging(pool);
  const descriptions = [
    "amenity=restaurant", "amenity=cafe", "amenity=bar", "amenity=place_of_worship", "amenity=fountain",
    "amenity=bank", "amenity=school", "shop=bakery", "shop=clothes", "tourism=hotel", "tourism=apartment",
    "tourism=museum", "tourism=attraction", "tourism=artwork", "historic=memorial", "leisure=park",
    "leisure=garden", "leisure=fitness_centre", "railway=station", "public_transport=station",
    "aeroway=aerodrome", "natural=peak", "natural=water", "man_made=tower", "place=square",
    "office=company", "craft=carpenter", "healthcare=doctor", "Dining and Drinking > Bar > Pub",
    "coffee_shop food_and_drink > cafe", "parking", "theme_park", "public_plaza", "",
  ];
  const { rows } = await pool.query("SELECT d, ref_next.category_group(d) AS g FROM unnest($1::text[]) AS d", [descriptions]);
  assert.deepEqual(
    rows.map((r) => [r.d, r.g]),
    descriptions.map((d) => [d, categoryGroup(d)]),
  );
});

test("osm2pgsql imports named places and streets, and skips the rest", { skip }, async () => {
  await prepareStaging(pool);
  await importOsm({ databaseUrl: TEST_DATABASE_URL, file: FIXTURE });
  const counts = await buildReference(pool);
  await swapReference(pool, { sources: { osm: "fixture" }, bbox: null }, counts);

  const { rows } = await pool.query(
    "SELECT origin, name, category, category_group, wikidata FROM ref.places ORDER BY origin",
  );
  assert.deepEqual(rows, [
    { origin: osm("node", 1), name: "Zur Linde", category: "amenity=restaurant", category_group: "food_drink", wikidata: "Q123" },
    { origin: osm("node", 4), name: "Hermannplatz", category: "railway=station", category_group: "transit", wikidata: null },
    { origin: osm("node", 5), name: "Denkmal", category: "historic=memorial", category_group: "sights", wikidata: null },
    { origin: osm("node", 6), name: "Bäckerei Hermann", category: "shop=bakery", category_group: "food_drink", wikidata: null },
    { origin: osm("relation", 300), name: "Neuer See", category: "natural=water", category_group: "nature", wikidata: null },
    { origin: osm("way", 100), name: "Körnerpark", category: "leisure=park", category_group: "nature", wikidata: null },
  ]);

  const names = await pool.query("SELECT origin, kind, name FROM ref.place_names ORDER BY origin, kind");
  assert.deepEqual(names.rows, [
    { origin: osm("node", 1), kind: "en", name: "The Lime Tree" },
    { origin: osm("way", 100), kind: "alt_name", name: "Koernerpark" },
  ]);

  // Outlines become one point inside them.
  const park = await pool.query(
    "SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng FROM ref.places WHERE origin = $1",
    [osm("way", 100)],
  );
  assert.ok(Math.abs(park.rows[0].lat - 52.471) < 1e-6 && Math.abs(park.rows[0].lng - 13.441) < 1e-6);

  const streets = await pool.query("SELECT name FROM ref.streets");
  assert.deepEqual(streets.rows, [{ name: "Weserstraße" }]);
});

test("the osmium filter keeps exactly what the style keeps", { skip }, async () => {
  const snapshot = async () => ({
    places: (
      await pool.query(
        `SELECT osm_type, osm_id, name, category, wikidata, names, ST_AsText(geom) AS geom
         FROM ref_next.stage_osm_places ORDER BY osm_type, osm_id`,
      )
    ).rows,
    streets: (await pool.query("SELECT osm_id, name, ST_AsText(geom) AS geom FROM ref_next.stage_osm_streets ORDER BY osm_id")).rows,
  });
  await prepareStaging(pool);
  await importOsm({ databaseUrl: TEST_DATABASE_URL, file: FIXTURE, filter: false });
  const unfiltered = await snapshot();
  await prepareStaging(pool);
  await importOsm({ databaseUrl: TEST_DATABASE_URL, file: FIXTURE });
  assert.deepEqual(await snapshot(), unfiltered);
  assert.ok(unfiltered.places.some((p) => p.osm_type === "R"), "including a multipolygon built from its member ways");
});

// The filter is lossless only because of two things the style does: it considers no
// key outside OSM_FILTER_KEYS, and it keeps nothing without a name.
test("the osmium filter covers every key the style reads, and the style needs names", () => {
  const style = readFileSync(OSM_STYLE, "utf8");
  const keys = [...style.matchAll(/\{ key = '([a-z_]+)'/g)].map((m) => m[1]!);
  assert.ok(keys.length > 10, "found the style's KEYS");
  assert.deepEqual([...keys, "highway"].sort(), [...OSM_FILTER_KEYS].sort());
  assert.match(style, /if not tags\.name or geom == nil/, "places need a name");
  assert.match(style, /if tags\.name and STREET_TYPES\[tags\.highway\]/, "streets need a name");
});

test("without address data the street comes from OpenStreetMap", { skip }, async () => {
  const app = buildApp({ pool });
  // ~10 m off the middle of the Weserstraße segment; no address data in this load.
  const res = await app.inject({ method: "POST", url: "/v1/suggestions", payload: { lat: 52.48859, lng: 13.43208 } });
  const { street } = res.json();
  assert.equal(street.name, "Weserstraße");
  assert.ok(Math.abs(street.lat - 52.4885) < 1e-4 && Math.abs(street.lng - 13.432) < 1e-4, "middle of the segment");
  await app.close();
});
