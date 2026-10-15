import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Pool } from "../src/db.ts";
import { reattachOrphans } from "../src/live.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase } from "./helpers/db.ts";
import { HERE, loadFixtures, type FixturePlace } from "./helpers/reference.ts";

const TOKEN = "test-token-0123456789abcdef0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const FSQ = "foursquare.com";
const OV = "overturemaps.org";
const urn = (dataset: string, id: string) => `urn:atgeo:${dataset}:place:${id}`;

let pool: Pool;
let app: FastifyInstance;

// Two cafés at the same distance; the McDonald's exists in two sources.
const PLACES: FixturePlace[] = [
  { dataset: FSQ, id: "mc", name: "McDonald's", group: "food_drink", north: 8, east: 0 },
  { dataset: OV, id: "mc", name: "McDonald's", group: "food_drink", north: 30, east: 0 },
  { dataset: FSQ, id: "a", name: "Café Alpha", group: "food_drink", north: 0, east: 60 },
  { dataset: FSQ, id: "b", name: "Café Beta", group: "food_drink", north: 0, east: -60 },
  { dataset: OV, id: "solo-v1", name: "Kiezkantine", group: "food_drink", north: 0, east: 120 },
  { dataset: OV, id: "gone", name: "Closed For Good", group: "food_drink", north: 0, east: 150 },
];

const checkin = (uri: string, place: string, daysAgo = 1) => ({
  uri: `at://did:plc:test/app.example.checkin/${uri}`,
  place,
  createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
});

async function report(events: unknown[]) {
  return app.inject({ method: "POST", url: "/internal/checkins", headers: AUTH, payload: { events } });
}

async function places() {
  const res = await app.inject({ method: "POST", url: "/v1/suggestions", payload: HERE });
  return res.json().places as Array<{ origin: string; name: string; checkins: { total: number; last30d: number } }>;
}

before(async () => {
  pool = await freshDatabase();
  await loadFixtures(pool, { places: PLACES });
  app = buildApp({ pool, internalToken: TOKEN });
});

after(async () => {
  await app?.close();
  await pool?.end();
});

test("internal routes need the token, and do not exist without one", async () => {
  const noToken = await app.inject({ method: "GET", url: "/internal/overrides" });
  assert.equal(noToken.statusCode, 401);
  const wrong = await app.inject({ method: "GET", url: "/internal/overrides", headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.statusCode, 401);
  const plain = buildApp({ pool });
  assert.equal((await plain.inject({ method: "GET", url: "/internal/overrides", headers: AUTH })).statusCode, 404);
  await plain.close();
});

test("check-ins are counted once per record, deleted ones drop out", async () => {
  const res = await report([
    checkin("1", urn(FSQ, "b")),
    checkin("2", urn(FSQ, "b")),
    checkin("2", urn(FSQ, "b")), // delivered twice
    checkin("3", urn(FSQ, "b"), 45), // older than 30 days
    checkin("4", urn(FSQ, "b")),
  ]);
  assert.equal(res.statusCode, 200);
  await report([{ uri: "at://did:plc:test/app.example.checkin/4", action: "delete" }]);

  const beta = (await places()).find((p) => p.name === "Café Beta")!;
  assert.deepEqual(beta.checkins, { total: 3, last30d: 2 });
});

test("check-ins lift a place above an equally close one", async () => {
  const names = (await places()).map((p) => p.name);
  assert.ok(names.indexOf("Café Beta") < names.indexOf("Café Alpha"));
});

test("check-ins under any of a merged place's IDs count for it", async () => {
  await report([checkin("5", urn(OV, "mc")), checkin("6", urn(FSQ, "mc"))]);
  const mc = (await places()).find((p) => p.name === "McDonald's")!;
  assert.equal(mc.origin, urn(FSQ, "mc"));
  assert.deepEqual(mc.checkins, { total: 2, last30d: 2 });
});

test("bad check-in reports are refused", async () => {
  assert.equal((await report([{ uri: "https://example.org/x", place: urn(FSQ, "a"), createdAt: new Date().toISOString() }])).statusCode, 400);
  assert.equal((await report([{ uri: "at://did:plc:test/x/1", place: "not-a-urn", createdAt: new Date().toISOString() }])).statusCode, 400);
  assert.equal((await report([{ uri: "at://did:plc:test/x/1" }])).statusCode, 400, "a create needs place and date");
});

test("overrides hide and rename places, also through another source's ID", async () => {
  const put = (key: string, body: object) =>
    app.inject({ method: "PUT", url: `/internal/overrides/${encodeURIComponent(key)}`, headers: AUTH, payload: body });

  assert.equal((await put(urn(OV, "mc"), { hidden: true, note: "test" })).statusCode, 200);
  assert.ok(!(await places()).some((p) => p.name === "McDonald's"));

  await put(urn(OV, "mc"), { hidden: false });
  await put(urn(FSQ, "a"), { name: "Café Alpha (Hermannplatz)" });
  const names = (await places()).map((p) => p.name);
  assert.ok(names.includes("McDonald's") && names.includes("Café Alpha (Hermannplatz)"));

  const list = (await app.inject({ method: "GET", url: "/internal/overrides", headers: AUTH })).json().overrides;
  assert.deepEqual(list.map((o: { placeKey: string }) => o.placeKey).sort(), [urn(FSQ, "a"), urn(OV, "mc")]);

  const del = await app.inject({ method: "DELETE", url: `/internal/overrides/${encodeURIComponent(urn(FSQ, "a"))}`, headers: AUTH });
  assert.equal(del.statusCode, 204);
  assert.ok((await places()).some((p) => p.name === "Café Alpha"));
});

test("after a load that changes a place's ID, its check-ins follow it", async () => {
  await report([checkin("7", urn(OV, "solo-v1")), checkin("8", urn(OV, "solo-v1")), checkin("9", urn(OV, "gone"))]);

  // Next release: Overture re-identified the Kiezkantine (and moved it 5 m); "gone" is gone.
  await loadFixtures(pool, {
    places: [
      ...PLACES.filter((p) => p.id !== "solo-v1" && p.id !== "gone"),
      { dataset: OV, id: "solo-v2", name: "Kiezkantine", group: "food_drink", north: 5, east: 120 },
    ],
  });
  const result = await reattachOrphans(pool);
  assert.deepEqual(result.moved, [{ from: urn(OV, "solo-v1"), to: urn(OV, "solo-v2") }]);
  assert.deepEqual(result.unmatched, [urn(OV, "gone")]);

  const kantine = (await places()).find((p) => p.name === "Kiezkantine")!;
  assert.equal(kantine.origin, urn(OV, "solo-v2"));
  assert.equal(kantine.checkins.total, 2);

  // A check-in an app publishes under the old ID still lands on the place.
  await report([checkin("10", urn(OV, "solo-v1"))]);
  const after = (await places()).find((p) => p.name === "Kiezkantine")!;
  assert.equal(after.checkins.total, 3);

  // Check-ins on a place that has no successor are kept, not deleted.
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM live.checkins WHERE place_key = $1", [urn(OV, "gone")]);
  assert.equal(rows[0].n, 1);
});
