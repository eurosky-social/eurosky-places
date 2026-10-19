import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Pool } from "../src/db.ts";
import { APPROXIMATE_MIN_SIMILARITY, SEARCH_SQL } from "../src/search.ts";
import { SUGGEST_SQL } from "../src/suggest.ts";
import { freshDatabase } from "./helpers/db.ts";
import { box, HERE, loadFixtures } from "./helpers/reference.ts";

// Query plans the worldwide speed depends on (EUR-482). The test data is tiny, so the
// planner would rightly scan whole tables; with sequential scans and sorts made expensive,
// it shows which index plans each query allows. A query rewritten so that one of these is
// impossible again (a CTE for the position, a constant name lookup, an expression that no
// longer matches its index) fails here instead of in production.

let pool: Pool;

before(async () => {
  pool = await freshDatabase();
  await loadFixtures(pool, {
    places: [
      { dataset: "openstreetmap.org", id: "1", name: "Brandenburger Tor", category: "tourism=attraction", group: "sights",
        north: 4000, east: -2000, wikidata: "Q82425", importance: 0.6 },
      { dataset: "foursquare.com", id: "cafe", name: "Café Kreuzberg", category: "Café", group: "food_drink", north: 100, east: 0 },
      { dataset: "foursquare.com", id: "atm", name: "Geldautomat", category: "ATM", group: "services", north: 10, east: 0 },
    ],
    areas: [{ id: "be", subtype: "region", name: "Berlin", country: "DE", wkt: box(13, 52.3, 13.8, 52.7), wikidata: "Q64", importance: 0.75 }],
    addresses: [{ street: "Hermannplatz", number: "1", north: 5, east: 5 }],
  });
});

after(async () => {
  await pool?.end();
});

async function plan(sql: string, params: unknown[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("SET enable_seqscan = off");
    await client.query("SET enable_sort = off");
    const { rows } = await client.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  } finally {
    await client.query("RESET ALL");
    client.release();
  }
}

const at = [HERE.lng, HERE.lat];
const PICKED = ["food_drink", "culture", "transit", "sights", "nature", "lodging"];

test("suggestions walk the spatial indexes nearest-first", async () => {
  const places = await plan(SUGGEST_SQL.places, [...at, 500, PICKED, 400, 100]);
  assert.equal(places.match(/Order By: \(geog <->/g)?.length, 2, places);
  assert.match(places, /places_geog_idx/);
  const street = await plan(SUGGEST_SQL.street, at);
  assert.match(street, /Index Scan using addresses_geog_idx[\s\S]*Order By: \(geog <->/, street);
  const osm = await plan(SUGGEST_SQL.osmStreet, at);
  assert.match(osm, /Index Scan using streets_geog_idx[\s\S]*Order By: \(geog <->/, osm);
});

test("the position is not a planning-time constant in spatial conditions", async () => {
  // As a constant, Postgres estimates each spatial condition from the column statistics:
  // ~1 ms of planning per condition on the worldwide data.
  for (const [name, sql, params] of [
    ["places", SUGGEST_SQL.places, [...at, 500, PICKED, 400, 100]],
    ["areas", SUGGEST_SQL.areas, at],
    ["containing", SEARCH_SQL.containing, at],
  ] as const) {
    const p = await plan(sql, [...params]);
    assert.match(p, /InitPlan/, `${name}: ${p}`);
    assert.doesNotMatch(p, /'0101000020E6/, `${name}: ${p}`);
  }
});

test("type-ahead looks names up within the grid cells around the user", async () => {
  for (const q of ["Ca", "Café", "Café Kreuzb"]) {
    const sql = q.length >= 3 ? SEARCH_SQL.nearby : SEARCH_SQL.nearbyShort;
    const p = await plan(sql, [q, ...at]);
    assert.match(p, /Bitmap Index Scan on places_name_idx\n\s+Index Cond: \(\(cell = .*name_norm\) ~~/, `${q}: ${p}`);
    assert.doesNotMatch(p, /places_geog_idx/, `${q}: ${p}`);
  }
});

test("notable names come from the index that fits the length of the text", async () => {
  const cases = [
    ["Br", "search_names_prefix2_idx"],
    ["Bra", "search_names_prefix3_idx"],
    ["Brandenb", "search_names_term_idx"],
  ] as const;
  for (const [q, index] of cases) {
    const p = await plan(SEARCH_SQL.notable, [q]);
    assert.match(p, new RegExp(`using ${index}|on ${index}`), `${q}: ${p}`);
    assert.equal(p.match(/One-Time Filter: false/g)?.length, 2, `only one branch runs for ${q}: ${p}`);
  }
  const near = await plan(SEARCH_SQL.notableNear, ["Br", ...at]);
  assert.match(near, /search_names_(cell|term|prefix2)_idx/, near);
});

test("typo search's index threshold is the similarity search asks for", async () => {
  const { rows } = await pool.query(
    "SELECT current_setting('pg_trgm.similarity_threshold')::float8 AS threshold, similarity('cafe kreuz', 'kreuzberg') AS sim, 'cafe kreuz' % 'kreuzberg' AS hit",
  );
  assert.equal(rows[0].threshold, APPROXIMATE_MIN_SIMILARITY);
  assert.ok(rows[0].sim > 0.3 && rows[0].sim < APPROXIMATE_MIN_SIMILARITY, String(rows[0].sim));
  assert.equal(rows[0].hit, false, "the index leaves out what search would drop anyway");
});
