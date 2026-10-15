import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "../src/db.ts";
import { recordCheckins, setOverride } from "../src/live.ts";
import { buildApp } from "../src/server.ts";
import { squareName, squareOf } from "../src/squares.ts";
import { freshDatabase } from "./helpers/db.ts";
import { box, loadFixtures } from "./helpers/reference.ts";

const FSQ = "foursquare.com";
const OV = "overturemaps.org";
const urn = (dataset: string, id: string) => `urn:atgeo:${dataset}:place:${id}`;
const SQUARE = "52.48,13.42"; // 52.48–52.49 N, 13.42–13.43 E: contains Hermannplatz (52.4867, 13.4245)

let pool: Pool;
let app: FastifyInstance;

async function get(url: string, server = app) {
  return server.inject({ method: "GET", url });
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
  const res = await get(`/v1/squares/${SQUARE}`);
  assert.equal(res.statusCode, 503);
});

test("loads fixtures", async () => {
  await loadFixtures(pool, {
    places: [
      { dataset: FSQ, id: "mc", name: "McDonald's", group: "food_drink", north: 8, east: 0 },
      { dataset: OV, id: "mc", name: "McDonald's", group: "food_drink", north: 30, east: 0 },
      { dataset: OV, id: "atm", name: "ING-Geldautomat", group: "services", north: 0, east: 5 },
      { dataset: FSQ, id: "u8", name: "U Hermannplatz", group: "transit", north: 0, east: -12 },
      { dataset: FSQ, id: "home", name: "Haus Rudigier", group: "lodging", north: 20, east: 20 },
      { dataset: FSQ, id: "cafe", name: "Café Kreuzberg", group: "food_drink", north: 100, east: 0 },
      { dataset: FSQ, id: "hux", name: "Huxleys Neue Welt", group: "culture", north: -320, east: 0 },
      // 52.4867 + 370 m ≈ 52.49002: just past the square's north edge.
      { dataset: FSQ, id: "north", name: "Next Square Bar", group: "food_drink", north: 370, east: 0 },
    ],
    areas: [
      { id: "de", subtype: "country", name: "Testland", country: "DE", wkt: box(12, 51, 15, 54) },
      { id: "be", subtype: "region", name: "Berlin", country: "DE", wkt: box(13, 52.3, 13.8, 52.7) },
      { id: "be-city", subtype: "locality", name: "Berlin", country: "DE", wkt: box(13.1, 52.35, 13.75, 52.65) },
      { id: "nk", subtype: "macrohood", name: "Neukölln", country: "DE", wkt: box(13.41, 52.45, 13.46, 52.488) },
      { id: "xb", subtype: "macrohood", name: "Kreuzberg", country: "DE", wkt: box(13.36, 52.488, 13.44, 52.51) },
    ],
  });
  await setOverride(pool, urn(FSQ, "home"), { hidden: true, note: "private home" });
  await recordCheckins(pool, [
    { uri: "at://did:plc:t/c/1", place: urn(FSQ, "hux"), createdAt: new Date().toISOString() },
    { uri: "at://did:plc:t/c/2", place: urn(FSQ, "hux"), createdAt: new Date().toISOString() },
  ]);
});

test("a square holds its places, merged, with hidden ones left out", async () => {
  const res = await get(`/v1/squares/${SQUARE}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "public, max-age=3600");
  const body = res.json();
  assert.deepEqual(body.square, { name: SQUARE, south: 52.48, west: 13.42, north: 52.49, east: 13.43 });

  const names = body.places.map((p: { name: string }) => p.name);
  assert.deepEqual([...names].sort(), ["Café Kreuzberg", "Huxleys Neue Welt", "ING-Geldautomat", "McDonald's", "U Hermannplatz"]);
  const mc = body.places.find((p: { name: string }) => p.name === "McDonald's");
  assert.deepEqual(mc.sameAs, [urn(OV, "mc")]);
  assert.equal(mc.distance, undefined, "no distance: the server does not know the user's position");
  assert.equal(body.next, null);
});

test("places come most important first", async () => {
  const names = (await get(`/v1/squares/${SQUARE}`)).json().places.map((p: { name: string }) => p.name);
  assert.equal(names[0], "Huxleys Neue Welt", "two check-ins");
  assert.equal(names.at(-1), "ING-Geldautomat", "services count least");
});

test("areas say whether they cover the whole square, with outlines for the rest", async () => {
  const { areas } = (await get(`/v1/squares/${SQUARE}`)).json();
  assert.deepEqual(
    areas.map((a: { name: string; subtype: string; whole: boolean }) => `${a.name}/${a.subtype}/${a.whole ? "whole" : "part"}`),
    ["Kreuzberg/macrohood/part", "Neukölln/macrohood/part", "Berlin/locality/whole", "Testland/country/whole"],
    "the region Berlin collapses into the city Berlin; partial areas are kept",
  );
  const neukoelln = areas.find((a: { name: string }) => a.name === "Neukölln");
  assert.equal(neukoelln.outline.type, "Polygon");
  // The app tests its own position against the outline: Hermannplatz is in Neukölln…
  const inside = await pool.query(
    "SELECT ST_Covers(ST_GeomFromGeoJSON($1), ST_SetSRID(ST_MakePoint(13.4245, 52.4867), 4326)) AS hit",
    [JSON.stringify(neukoelln.outline)],
  );
  assert.equal(inside.rows[0].hit, true);
  // …and the outline stays inside the square.
  const contained = await pool.query(
    "SELECT ST_Covers(ST_Buffer(ST_MakeEnvelope(13.42, 52.48, 13.43, 52.49, 4326), 0.0001), ST_GeomFromGeoJSON($1)) AS ok",
    [JSON.stringify(neukoelln.outline)],
  );
  assert.equal(contained.rows[0].ok, true);
  assert.ok(areas.filter((a: { whole: boolean }) => a.whole).every((a: { outline?: unknown }) => a.outline === undefined));
});

test("pages carry the next link; areas only on the first page", async () => {
  const small = buildApp({ pool, squarePageSize: 2 });
  const first = (await get(`/v1/squares/${SQUARE}`, small)).json();
  assert.equal(first.places.length, 2);
  assert.equal(first.next, `/v1/squares/${SQUARE}?page=2`);
  const third = (await get(first.next.replace("page=2", "page=3"), small)).json();
  assert.equal(third.places.length, 1);
  assert.equal(third.next, null);
  assert.equal(third.areas, undefined);
  const beyond = (await get(`/v1/squares/${SQUARE}?page=4`, small)).json();
  assert.deepEqual(beyond.places, []);
  await small.close();
});

test("a precise position, another spelling or extra parameters are refused", async () => {
  const refused = async (url: string, code: string) => {
    const res = await get(url);
    assert.equal(res.statusCode, 400, url);
    if (code) assert.equal(res.json().error, code, url);
  };
  await refused("/v1/squares/52.4867,13.4245", "TooPrecise");
  await refused("/v1/squares/52.4,13.42", "InvalidSquare");
  await refused("/v1/squares/052.48,13.42", "InvalidSquare");
  await refused("/v1/squares/-0.00,0.00", "InvalidSquare");
  await refused("/v1/squares/90.00,0.00", "InvalidSquare");
  await refused(`/v1/squares/${SQUARE}?lat=52.4867&lng=13.4245`, "");
});

test("the app finds its square by rounding down", () => {
  assert.equal(squareName(squareOf(52.4867, 13.4245)), "52.48,13.42");
  assert.equal(squareName(squareOf(52.49, 13.4245)), "52.49,13.42");
  assert.equal(squareName(squareOf(-0.005, -0.005)), "-0.01,-0.01");
  assert.equal(squareName(squareOf(0.004, 0.004)), "0.00,0.00");
});
