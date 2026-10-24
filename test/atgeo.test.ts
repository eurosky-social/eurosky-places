import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "../src/db.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase } from "./helpers/db.ts";
import { lexicons } from "./helpers/lexicons.ts";
import { box, loadFixtures } from "./helpers/reference.ts";

const OSM = "urn:atgeo:openstreetmap.org:node:1";
const FSQ = "urn:atgeo:foursquare.com:place:tor";
const OVERTURE = "urn:atgeo:overturemaps.org:place:ov-1";
const COUNTRY = "urn:atgeo:overturemaps.org:division:de";
const REGION = "urn:atgeo:overturemaps.org:division:be";
const DISTRICT = "urn:atgeo:overturemaps.org:division:xb";

let pool: Pool;
let app: FastifyInstance;

const getPlace = (uri?: string, target = app) =>
  target.inject({
    method: "GET",
    url: "/xrpc/org.atgeo.getPlace" + (uri === undefined ? "" : `?uri=${encodeURIComponent(uri)}`),
  });

before(async () => {
  pool = await freshDatabase();
  app = buildApp({ pool, publicBaseUrl: "https://places.example" });
});

after(async () => {
  await app?.close();
  await pool?.end();
});

test("before any data load it says so", async () => {
  const res = await getPlace(OSM);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "NoData");
});

test("loads fixtures", async () => {
  await loadFixtures(pool, {
    places: [
      {
        dataset: "openstreetmap.org", id: "1", name: "Brandenburger Tor", category: "tourism=attraction", group: "sights",
        north: 0, east: 0, wikidata: "Q82425",
        names: { en: "Brandenburg Gate", alt_name: "Brandenburger Thor", zh_pinyin: "Bolandengbao Men" },
      },
      // The same gate in Foursquare, 10 m away: suggestions merge the two.
      { dataset: "foursquare.com", id: "tor", name: "Brandenburger Tor", category: "Monument", group: "sights", north: 10, east: 0 },
      // Not the same place: other name, 2 km away.
      { dataset: "overturemaps.org", id: "ov-1", name: "Café Kreuzberg", category: "cafe", group: "food_drink", north: 2000, east: 0 },
    ],
    areas: [
      { id: "de", subtype: "country", name: "Testland", country: "DE", wkt: box(5, 47, 15, 55), wikidata: "Q183", population: 83_000_000 },
      { id: "be", subtype: "region", name: "Berlin", country: "DE", wkt: box(13, 52.3, 13.8, 52.7), wikidata: "Q64" },
      { id: "xb", subtype: "macrohood", name: "Kreuzberg", country: "DE", wkt: box(13.36, 52.45, 13.46, 52.51) },
    ],
  });
});

test("a place comes back as an org.atgeo.place, shaped like garganorn's", async () => {
  const res = await getPlace(OSM);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "public, max-age=3600");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  const view = res.json();
  assert.equal(view.uri, `https://places.example/xrpc/org.atgeo.getPlace?uri=${encodeURIComponent(OSM)}`);
  const { record } = view;
  assert.equal(record.$type, "org.atgeo.place");
  assert.equal(record.origin, OSM);
  assert.equal(record.name, "Brandenburger Tor");
  assert.deepEqual(record.locations, [{ $type: "community.lexicon.location.geo", latitude: "52.486700", longitude: "13.424500" }]);
  assert.deepEqual(record.attributes, { tourism: "attraction", wikidata: "Q82425" });
  assert.deepEqual(
    record.variants.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    [
      { name: "Bolandengbao Men", type: "alternate" },
      { name: "Brandenburg Gate", type: "alternate", language: "en" },
      { name: "Brandenburger Thor", type: "alternate" },
    ],
    "zh_pinyin is not a language tag, so it stays a variant without one",
  );
  assert.deepEqual(record.relations.within, [
    { uri: COUNTRY, name: "Testland", type: "country" },
    { uri: REGION, name: "Berlin", type: "region" },
    { uri: DISTRICT, name: "Kreuzberg", type: "macrohood" },
  ]);
  assert.deepEqual(record.relations.sameAs, [{ uri: FSQ, name: "Brandenburger Tor" }]);
});

test("its twin in another source points back, and an unrelated place has none", async () => {
  const twin = (await getPlace(FSQ)).json().record;
  assert.deepEqual(twin.attributes, { category: "Monument" });
  assert.deepEqual(twin.relations.sameAs, [{ uri: OSM, name: "Brandenburger Tor" }]);
  const cafe = (await getPlace(OVERTURE)).json().record;
  assert.deepEqual(cafe.attributes, { categories: { primary: "cafe" } });
  assert.equal(cafe.relations.sameAs, undefined);
});

test("an area comes back with the larger areas that contain it", async () => {
  const res = await getPlace(REGION);
  assert.equal(res.statusCode, 200, res.body);
  const { record } = res.json();
  assert.equal(record.name, "Berlin");
  // Berlin's region is the city itself (src/places/city-states.ts).
  assert.deepEqual(record.attributes, { subtype: "region", country: "DE", wikidata: "Q64", cityState: true });
  assert.deepEqual(record.relations.within, [{ uri: COUNTRY, name: "Testland", type: "country" }]);
  assert.equal(record.locations.length, 1);
  const country = (await getPlace(COUNTRY)).json().record;
  assert.deepEqual(country.attributes, { subtype: "country", country: "DE", population: 83_000_000, wikidata: "Q183" });
  assert.deepEqual(country.relations.within, []);
  const district = (await getPlace(DISTRICT)).json().record;
  assert.deepEqual(district.attributes, { subtype: "macrohood", country: "DE" });
});

test("answers validate against ATGeo's published lexicons", async () => {
  const lex = await lexicons();
  for (const uri of [OSM, FSQ, OVERTURE, COUNTRY, REGION, DISTRICT]) {
    const view = (await getPlace(uri)).json();
    lex.assertValidXrpcOutput("org.atgeo.getPlace", view);
    lex.assertValidRecord("org.atgeo.place", view.record);
  }
});

test("unknown places and bad requests get XRPC errors", async () => {
  for (const uri of ["urn:atgeo:openstreetmap.org:node:999", "urn:atgeo:nowhere", "https://example.com/place"]) {
    const res = await getPlace(uri);
    assert.equal(res.statusCode, 400, uri);
    assert.deepEqual(res.json(), { error: "PlaceNotFound", message: `No such place: ${uri}` });
  }
  const missing = await getPlace();
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "InvalidRequest");
});

test("without a configured public URL, links follow the request", async () => {
  const plain = buildApp({ pool });
  try {
    const view = (await getPlace(OSM, plain)).json();
    assert.match(view.uri, /^http:\/\/localhost(:\d+)?\/xrpc\/org\.atgeo\.getPlace\?uri=/);
  } finally {
    await plain.close();
  }
});
