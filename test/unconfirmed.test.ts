import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "../src/db.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase } from "./helpers/db.ts";
import { box, HERE, loadFixtures } from "./helpers/reference.ts";

// Overture records placed by their town alone ("unconfirmed": only Meta vouches for them
// and their address has no street) are suggested only together with a Foursquare or
// OpenStreetMap twin within merging distance (EUR-480). Search still finds them.

const FSQ = "foursquare.com";
const OV = "overturemaps.org";
const OSM = "openstreetmap.org";
const urn = (dataset: string, id: string, collection = "place") => `urn:atgeo:${dataset}:${collection}:${id}`;

let pool: Pool;
let app: FastifyInstance;

before(async () => {
  pool = await freshDatabase();
  app = buildApp({ pool });
  await loadFixtures(pool, {
    places: [
      // The Ajinomoto Stadium case: placed by its town alone, no other source nearby.
      { dataset: OV, id: "stadium", name: "Ajinomoto Stadium", category: "stadium_arena", group: "culture", north: 6, east: 0, unconfirmed: true },
      // Confirmed by Foursquare 40 m away, and by OpenStreetMap 60 m away.
      { dataset: OV, id: "bakery", name: "Bäckerei Hermann", category: "bakery", group: "food_drink", north: 20, east: 0, unconfirmed: true },
      { dataset: FSQ, id: "bakery", name: "Bäckerei Hermann", category: "Bakery", group: "food_drink", north: 60, east: 0 },
      { dataset: OV, id: "kiosk", name: "Kiosk am Platz", category: "convenience_store", group: "shopping", north: 0, east: 30, unconfirmed: true },
      { dataset: OSM, id: "7", name: "Kiosk am Platz", category: "shop=kiosk", group: "shopping", north: 0, east: 90 },
      // The same name 120 m away is too far to be the same place.
      { dataset: OV, id: "far", name: "Bar Centrale", category: "bar", group: "food_drink", north: -10, east: 0, unconfirmed: true },
      { dataset: FSQ, id: "far", name: "Bar Centrale", category: "Bar", group: "food_drink", north: -130, east: 0 },
      // Not unconfirmed (another source, or a street address): shown on its own.
      { dataset: OV, id: "confirmed", name: "Buchhandlung Hermann", category: "bookstore", group: "shopping", north: 0, east: -20 },
    ],
    areas: [{ id: "de", subtype: "country", name: "Testland", country: "DE", wkt: box(12, 51, 15, 54) }],
  });
});

after(async () => {
  await app?.close();
  await pool?.end();
});

test("an unconfirmed record is suggested only together with a Foursquare or OpenStreetMap twin", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/suggestions", payload: HERE });
  assert.equal(res.statusCode, 200);
  const places = res.json().places as Array<{ origin: string; sameAs: string[]; name: string; distance: number }>;
  const byName = new Map(places.map((p) => [p.name, p]));

  assert.equal(byName.get("Ajinomoto Stadium"), undefined, "alone: left out");
  assert.deepEqual(
    { origin: byName.get("Bäckerei Hermann")?.origin, sameAs: byName.get("Bäckerei Hermann")?.sameAs },
    { origin: urn(FSQ, "bakery"), sameAs: [urn(OV, "bakery")] },
    "with a Foursquare twin: one place, under the twin's ID",
  );
  assert.deepEqual(
    { origin: byName.get("Kiosk am Platz")?.origin, sameAs: byName.get("Kiosk am Platz")?.sameAs },
    { origin: urn(OSM, "7", "node"), sameAs: [urn(OV, "kiosk")] },
    "with an OpenStreetMap twin",
  );
  // The twin is 120 m away: only the Foursquare record is suggested, at its own position.
  assert.deepEqual(
    places.filter((p) => p.name === "Bar Centrale").map((p) => [p.origin, p.sameAs]),
    [[urn(FSQ, "far"), []]],
  );
  assert.equal(byName.get("Buchhandlung Hermann")?.origin, urn(OV, "confirmed"), "other sources than Meta: shown alone");
});

test("squares leave out unconfirmed records without a twin too", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/squares/52.48,13.42" });
  assert.equal(res.statusCode, 200);
  const origins = (res.json().places as Array<{ origin: string }>).map((p) => p.origin).sort();
  assert.deepEqual(origins, [
    urn(FSQ, "bakery"),
    urn(FSQ, "far"),
    urn(OSM, "7", "node"),
    urn(OV, "confirmed"),
  ]);
});

test("search still finds an unconfirmed record on its own", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { q: "Ajinomoto", ...HERE } });
  assert.equal(res.statusCode, 200);
  const results = res.json().results as Array<{ origin: string; name: string }>;
  assert.deepEqual(
    results.map((r) => [r.origin, r.name]),
    [[urn(OV, "stadium"), "Ajinomoto Stadium"]],
  );
});
