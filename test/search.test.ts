import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "../src/db.ts";
import { setOverride } from "../src/live.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase } from "./helpers/db.ts";
import { box, HERE, loadFixtures } from "./helpers/reference.ts";

const FSQ = "foursquare.com";
const OSM = "openstreetmap.org";

let pool: Pool;
let app: FastifyInstance;

interface Result {
  kind: string;
  origin: string;
  sameAs: string[];
  name: string;
  matched?: string;
  match: string;
  subtype?: string;
  cityState?: boolean;
  distance?: number;
}

async function search(body: Record<string, unknown>): Promise<Result[]> {
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: body });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  return res.json().results;
}
const names = (results: Result[]) => results.map((r) => r.name);

before(async () => {
  pool = await freshDatabase();
  app = buildApp({ pool });
});

after(async () => {
  await app?.close();
  await pool?.end();
});

test("before any data load the endpoint says so", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { q: "Berlin" } });
  assert.equal(res.statusCode, 503);
});

test("loads fixtures", async () => {
  await loadFixtures(pool, {
    places: [
      // Brandenburger Tor, ~4.5 km from Hermannplatz, in two sources.
      {
        dataset: OSM, id: "1", name: "Brandenburger Tor", category: "tourism=attraction", group: "sights",
        north: 4000, east: -2000, wikidata: "Q82425", importance: 0.6,
        names: { en: "Brandenburg Gate", fr: "Porte de Brandebourg" },
      },
      { dataset: FSQ, id: "tor", name: "Brandenburger Tor", category: "Monument", group: "sights", north: 4010, east: -2000 },
      { dataset: OSM, id: "2", name: "Fernsehturm", category: "tourism=attraction", group: "sights", north: 3500, east: -500, wikidata: "Q151", importance: 0.65 },
      // Nearby, not famous.
      { dataset: FSQ, id: "hof", name: "Brandenburger Hof", category: "Café", group: "food_drink", north: 300, east: 0 },
      { dataset: FSQ, id: "cafe", name: "Café Kreuzberg", category: "Café", group: "food_drink", north: 100, east: 0 },
      { dataset: FSQ, id: "spaeti", name: "Kreuzberger Späti", category: "Convenience Store", group: "shopping", north: 150, east: 0 },
      { dataset: FSQ, id: "tor7", name: "Tor 7 Bar", category: "Bar", group: "food_drink", north: 500, east: 0 },
      // Two stations of the same name (U-Bahn and S-Bahn), separate OSM objects.
      { dataset: OSM, id: "3", name: "Brandenburger Tor", category: "railway=station", group: "transit", north: 3950, east: -2050, wikidata: "Q500", importance: 0.4 },
      { dataset: OSM, id: "4", name: "Brandenburger Tor", category: "railway=station", group: "transit", north: 3900, east: -2100, wikidata: "Q501", importance: 0.4 },
      // One famous thing mapped twice, far apart.
      { dataset: OSM, id: "5", name: "Berliner Mauer", category: "historic=memorial", group: "sights", north: 3000, east: -1000, wikidata: "Q5070", importance: 0.7 },
      { dataset: OSM, id: "6", name: "Berliner Mauer", category: "historic=memorial", group: "sights", north: 6000, east: 2000, wikidata: "Q5070", importance: 0.7 },
      // Exactly what is typed, but not famous; a famous area is only a typo away.
      { dataset: FSQ, id: "feld", name: "Tempelhofer Feld", category: "Park", group: "nature", north: -1500, east: -500 },
      // Far away and not famous: found by neither tier.
      { dataset: FSQ, id: "imbiss", name: "Brandenburger Imbiss", category: "Snack Place", group: "food_drink", north: -480_000, east: 0 },
    ],
    areas: [
      { id: "de", subtype: "country", name: "Testland", country: "DE", wkt: box(5, 47, 15, 55), wikidata: "Q183", importance: 0.8 },
      { id: "be", subtype: "region", name: "Berlin", country: "DE", wkt: box(13, 52.3, 13.8, 52.7), wikidata: "Q64", importance: 0.75, names: { it: "Berlino", fr: "Berlin" } },
      { id: "bb", subtype: "region", name: "Brandenburg", country: "DE", wkt: box(11.5, 51.5, 12.9, 53.5), wikidata: "Q1208", importance: 0.7 },
      { id: "xb", subtype: "macrohood", name: "Kreuzberg", country: "DE", wkt: box(13.36, 52.488, 13.44, 52.51) },
      { id: "nk", subtype: "macrohood", name: "Neukölln", country: "DE", wkt: box(13.41, 52.45, 13.46, 52.488) },
      { id: "th", subtype: "neighborhood", name: "Tempelhof", country: "DE", wkt: box(13.37, 52.45, 13.41, 52.47), wikidata: "Q693497", importance: 0.55 },
    ],
  });
});

test("the famous place comes first, ahead of a closer one with a similar name", async () => {
  const results = await search({ q: "Brandenb", ...HERE });
  assert.equal(results[0]!.name, "Brandenburger Tor");
  assert.equal(results[0]!.origin, `urn:atgeo:${FSQ}:place:tor`, "merged across sources, Foursquare ID first");
  assert.deepEqual(results[0]!.sameAs, [`urn:atgeo:${OSM}:node:1`]);
  assert.ok(names(results).includes("Brandenburger Hof"));
  assert.ok(names(results).includes("Brandenburg"));
  assert.ok(!names(results).includes("Brandenburger Imbiss"), "neither famous nor nearby");
});

test("other names and languages find the place", async () => {
  const [gate] = await search({ q: "Brandenburg Gate", ...HERE });
  assert.equal(gate!.name, "Brandenburger Tor");
  assert.equal(gate!.matched, "Brandenburg Gate");
  assert.equal(gate!.match, "other_name");
  const berlin = (await search({ q: "Berlino" })).find((r) => r.kind === "area")!;
  assert.equal(berlin.name, "Berlin");
  assert.equal(berlin.matched, "Berlino");
});

test("a typo still finds famous places", async () => {
  const results = await search({ q: "Brandenbuger Tor", ...HERE });
  assert.equal(results[0]!.name, "Brandenburger Tor");
  assert.equal(results[0]!.match, "approximate");
  const [berlin] = await search({ q: "Berln" });
  assert.equal(berlin!.name, "Berlin");
});

test("a later word of the name matches too", async () => {
  const results = await search({ q: "tor", ...HERE });
  const tor = results.find((r) => r.name === "Brandenburger Tor")!;
  assert.equal(tor.match, "word");
  assert.equal(results.find((r) => r.name === "Tor 7 Bar")!.match, "start");
});

test("areas are found, the ones the user is in at distance 0", async () => {
  const kreuz = await search({ q: "Kreuz", ...HERE });
  const kreuzberg = kreuz.find((r) => r.kind === "area")!;
  assert.equal(kreuzberg.name, "Kreuzberg");
  assert.equal(kreuzberg.subtype, "macrohood");
  assert.ok(names(kreuz).includes("Kreuzberger Späti") && names(kreuz).includes("Café Kreuzberg"));

  const [neukoelln] = await search({ q: "Neuk", ...HERE });
  assert.equal(neukoelln!.name, "Neukölln");
  assert.equal(neukoelln!.distance, 0);
});

test("a city filed as a region is marked as a city-state, other areas and places are not", async () => {
  const berlin = await search({ q: "Berlin", ...HERE, limit: 30 });
  assert.equal(berlin.find((r) => r.kind === "area" && r.name === "Berlin")?.cityState, true);
  assert.ok(berlin.filter((r) => r.kind === "place").every((r) => r.cityState === undefined));
  const brandenburg = (await search({ q: "Brandenburg", ...HERE })).find((r) => r.kind === "area")!;
  assert.equal(brandenburg.name, "Brandenburg");
  assert.equal(brandenburg.cityState, undefined, "a state, not a city");
  const [kreuzberg] = (await search({ q: "Kreuzberg", ...HERE })).filter((r) => r.kind === "area");
  assert.equal(kreuzberg!.cityState, undefined);
});

test("without a position only notable places and areas are searched", async () => {
  const results = await search({ q: "Fernseh" });
  assert.deepEqual(names(results), ["Fernsehturm"]);
  assert.equal(results[0]!.distance, undefined);
  assert.deepEqual(await search({ q: "Café Kreuz" }), [], "too far from 'Kreuzberg' to count as a typo");
});

test("nearby places are found by the start of any word, two letters within 1 km", async () => {
  const cafe = await search({ q: "Café Kreuz", ...HERE });
  assert.equal(cafe.find((r) => r.name === "Café Kreuzberg")?.match, "start", "longer than the letters looked up");
  assert.ok(!(await search({ q: "Café Kreuzx", ...HERE })).some((r) => r.name === "Café Kreuzberg"), "the whole text counts");
  assert.ok(names(await search({ q: "Ca", ...HERE })).includes("Café Kreuzberg"), "two letters");
  assert.ok(!names(await search({ q: "rger", ...HERE })).includes("Brandenburger Hof"), "inside a word is no match");
  // Tempelhofer Feld is ~1.6 km away: beyond two letters' reach, within three letters'.
  assert.ok(!names(await search({ q: "Te", ...HERE, limit: 30 })).includes("Tempelhofer Feld"));
  assert.ok(names(await search({ q: "Tem", ...HERE, limit: 30 })).includes("Tempelhofer Feld"));
});

test("hidden places are not found", async () => {
  await setOverride(pool, `urn:atgeo:${OSM}:node:1`, { hidden: true });
  const results = (await search({ q: "Brandenb", ...HERE, limit: 30 })) as Array<Result & { group?: string }>;
  assert.ok(!results.some((r) => r.name === "Brandenburger Tor" && r.group === "sights"), "the monument is hidden");
  assert.ok(results.some((r) => r.name === "Brandenburger Tor" && r.group === "transit"), "the station is not");
  await setOverride(pool, `urn:atgeo:${OSM}:node:1`, { hidden: false });
});

test("the same thing is shown once", async () => {
  const tor = (await search({ q: "Brandenburger Tor", ...HERE, limit: 30 })).filter((r) => r.name === "Brandenburger Tor");
  assert.deepEqual(tor.map((r) => r.kind === "place" && r.match), ["start", "start"], "the monument and one station");
  const mauer = (await search({ q: "Berliner Mauer" })).filter((r) => r.name === "Berliner Mauer");
  assert.equal(mauer.length, 1, "same Wikidata ID");
});

test("typo matches only fill up the list after real matches", async () => {
  const results = await search({ q: "Tempelhofer", ...HERE });
  assert.equal(results[0]!.name, "Tempelhofer Feld");
  const tempelhof = results.find((r) => r.name === "Tempelhof");
  assert.ok(tempelhof && tempelhof.match === "approximate");
});

test("too little text gives nothing; bad requests are refused", async () => {
  assert.deepEqual(await search({ q: "?!" }), []);
  assert.deepEqual(await search({ q: "b" }), []);
  const bad = async (body: object) =>
    assert.equal((await app.inject({ method: "POST", url: "/v1/search", payload: body })).statusCode, 400, JSON.stringify(body));
  await bad({ q: "" });
  await bad({ q: "Berlin", lat: 52.5 });
  await bad({ q: "Berlin", limit: 100 });
  await bad({ q: "Berlin", extra: true });
});
