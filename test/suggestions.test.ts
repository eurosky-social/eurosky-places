import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "../src/db.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase } from "./helpers/db.ts";
import { box, HERE, loadFixtures, offset } from "./helpers/reference.ts";

let pool: Pool;
let app: FastifyInstance;

const FSQ = "foursquare.com";
const OV = "overturemaps.org";

async function ask(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/suggestions", payload: body });
}

before(async () => {
  pool = await freshDatabase();
  app = buildApp({ pool });
});

after(async () => {
  await app?.close();
  await pool?.end();
});

test("before any data load the endpoint says so", async () => {
  const res = await ask(HERE);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "NoData");
});

test("loads fixtures around Hermannplatz", async () => {
  await loadFixtures(pool, {
    places: [
      { dataset: FSQ, id: "mc", name: "McDonald's", category: "Fast Food Restaurant", group: "food_drink", north: 8, east: 0 },
      { dataset: OV, id: "mc", name: "McDonald's", category: "fast_food_restaurant", group: "food_drink", north: 35, east: 0 },
      { dataset: OV, id: "atm", name: "ING-Geldautomat", category: "atm", group: "services", north: 0, east: 5 },
      { dataset: FSQ, id: "u8", name: "U Hermannplatz", category: "Metro Station", group: "transit", north: 0, east: -12 },
      { dataset: OV, id: "plaza", name: "Hermannplatz", category: "public_plaza", group: "sights", north: 0, east: -12 },
      { dataset: FSQ, id: "hux", name: "Huxleys Neue Welt", category: "Music Venue", group: "culture", north: -320, east: 0 },
      { dataset: OV, id: "hux", name: "Huxleys Neue Welt", category: "music_venue", group: "culture", north: -340, east: 0 },
      { dataset: FSQ, id: "cafe", name: "Café Kreuzberg", category: "Café", group: "food_drink", north: 100, east: 0 },
      { dataset: OV, id: "cafe", name: "Cafe Kreuzberg", category: "cafe", group: "food_drink", north: 110, east: 0 },
      { dataset: FSQ, id: "spaeti-1", name: "Späti", category: "Convenience Store", group: "shopping", north: 50, east: 0 },
      { dataset: FSQ, id: "spaeti-2", name: "Späti", category: "Convenience Store", group: "shopping", north: 70, east: 0 },
      { dataset: FSQ, id: "far", name: "Far Away Café", category: "Café", group: "food_drink", north: 800, east: 0 },
    ],
    areas: [
      { id: "de", subtype: "country", name: "Testland", country: "DE", wkt: box(12, 51, 15, 54), wikidata: "Q183" },
      { id: "be", subtype: "region", name: "Berlin", country: "DE", wkt: box(13, 52.3, 13.8, 52.7), wikidata: "Q64" },
      // Neukölln and Kreuzberg meet at latitude 52.488, ~150 m north of the user.
      { id: "nk-borough", subtype: "locality", name: "Neukölln", country: "DE", wkt: box(13.4, 52.44, 13.47, 52.488) },
      { id: "nk", subtype: "macrohood", name: "Neukölln", country: "DE", wkt: box(13.41, 52.45, 13.46, 52.488) },
      { id: "hp", subtype: "microhood", name: "Hermannplatz", country: "DE", wkt: box(13.42, 52.484, 13.43, 52.488) },
      { id: "xb", subtype: "macrohood", name: "Kreuzberg", country: "DE", wkt: box(13.36, 52.488, 13.44, 52.51) },
    ],
    addresses: [
      { street: "Hermannplatz", number: "2", north: 15, east: 0 },
      { street: "Hermannplatz", number: "5", north: 0, east: 40 },
      { street: "Hermannplatz", number: "9", north: -60, east: 0 },
      { street: "Karl-Marx-Straße", number: "1", north: -120, east: 0 },
    ],
  });
});

test("nearby places are merged across sources and ranked", async () => {
  const res = await ask(HERE);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  const places = res.json().places as Array<Record<string, any>>;
  const names = places.map((p) => p.name);

  assert.equal(names[0], "McDonald's");
  assert.equal(places[0]!.origin, "urn:atgeo:foursquare.com:place:mc");
  assert.deepEqual(places[0]!.sameAs, ["urn:atgeo:overturemaps.org:place:mc"]);
  assert.ok(Math.abs(places[0]!.distance - 8) <= 1);

  // A station and a square that share a name stay two places.
  assert.ok(names.includes("U Hermannplatz") && names.includes("Hermannplatz"));
  // The ATM is closer than the station but ranks below it.
  assert.ok(names.indexOf("ING-Geldautomat") > names.indexOf("U Hermannplatz"));
  // Accents don't split a place; two shops of the same name in one source stay two.
  assert.equal(names.filter((n) => n.startsWith("Caf")).length, 1);
  assert.equal(names.filter((n) => n === "Späti").length, 2);
  // Within the default 500 m, but not beyond.
  assert.ok(names.includes("Huxleys Neue Welt"));
  assert.ok(!names.includes("Far Away Café"));
  assert.equal(places.length, 8);
});

test("the areas are the user's own, smallest first, same names collapsed", async () => {
  const body = (await ask(HERE)).json();
  assert.deepEqual(
    body.areas.map((a: { name: string; subtype: string }) => `${a.name}/${a.subtype}`),
    ["Hermannplatz/microhood", "Neukölln/macrohood", "Berlin/region", "Testland/country"],
  );
  const hp = body.areas[0];
  assert.equal(hp.origin, "urn:atgeo:overturemaps.org:division:hp");
  assert.ok(hp.lng >= 13.42 && hp.lng <= 13.43 && hp.lat >= 52.484 && hp.lat <= 52.488, "point lies inside the area");

  // 250 m north the user is in Kreuzberg, not Neukölln.
  const north = (await ask(offset(250, 0))).json();
  assert.deepEqual(
    north.areas.map((a: { name: string }) => a.name),
    ["Kreuzberg", "Berlin", "Testland"],
  );
});

test("a city filed as a region is marked as a city-state, other areas are not", async () => {
  const { areas } = (await ask(HERE)).json();
  assert.deepEqual(
    areas.filter((a: { cityState?: boolean }) => a.cityState !== undefined).map((a: { name: string; cityState: boolean }) => `${a.name}/${a.cityState}`),
    ["Berlin/true"],
    "Berlin's region is the city (Q64); the country's ID is not on the list",
  );
});

test("the street is named, with a point in its middle rather than at the user", async () => {
  const { street } = (await ask(HERE)).json();
  assert.equal(street.name, "Hermannplatz");
  const nearestAddress = offset(15, 0);
  assert.notDeepEqual([street.lat, street.lng], [nearestAddress.lat, nearestAddress.lng]);
});

test("radius and limit narrow the answer", async () => {
  const near = (await ask({ ...HERE, radius: 100 })).json().places.map((p: { name: string }) => p.name);
  assert.ok(!near.includes("Huxleys Neue Welt"));
  assert.equal((await ask({ ...HERE, limit: 3 })).json().places.length, 3);
});

test("a position with nothing around it gets empty lists", async () => {
  const body = (await ask({ lat: 0, lng: 0 })).json();
  assert.deepEqual(body, { places: [], street: null, areas: [] });
});

test("invalid requests are refused", async () => {
  assert.equal((await ask({ lat: 95, lng: 13 })).statusCode, 400);
  assert.equal((await ask({ lat: 52.5 })).statusCode, 400);
  assert.equal((await ask({ ...HERE, radius: 10_000 })).statusCode, 400);
  assert.equal((await ask({ ...HERE, extra: 1 })).statusCode, 400);
  const viaQuery = await app.inject({ method: "GET", url: `/v1/suggestions?lat=${HERE.lat}&lng=${HERE.lng}` });
  assert.equal(viaQuery.statusCode, 404);
});
