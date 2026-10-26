import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "../src/db.ts";
import { CheckinSink, PIN_COLLECTION, readCursor, subscribeUrl, toCheckin } from "../src/listener.ts";
import { freshDatabase } from "./helpers/db.ts";

let pool: Pool;

before(async () => {
  pool = await freshDatabase();
});

beforeEach(async () => {
  await pool.query("TRUNCATE live.checkins, live.place_snapshots, meta.listener_cursors");
});

after(async () => {
  await pool?.end();
});

const DID = "did:plc:abc123";
const PLACE = "urn:atgeo:foursquare.com:place:4ae774f1f964a5207dab21e3";

// A pin as the docs/place-pin.md examples publish it.
// null: a pin whose place has no ID (a street, say).
const pin = (origin: string | null = PLACE) => ({
  $type: PIN_COLLECTION,
  level: "venue",
  createdAt: "2026-10-20T12:00:00.000Z",
  place: {
    ...(origin ? { origin } : {}),
    name: "McDonald's",
    category: "food_drink",
    locations: [{ $type: "community.lexicon.location.geo", latitude: "52.48676", longitude: "13.42456" }],
  },
});

const commit = (operation: string, rkey: string, record?: unknown, timeUs = 1_760_000_000_000_000) => ({
  did: DID,
  time_us: timeUs,
  kind: "commit",
  commit: { rev: "3l3", operation, collection: PIN_COLLECTION, rkey, ...(record ? { record, cid: "bafy" } : {}) },
});

const uri = (rkey: string) => `at://${DID}/${PIN_COLLECTION}/${rkey}`;

async function rows() {
  const { rows } = await pool.query("SELECT uri, place_key, created_at FROM live.checkins ORDER BY uri");
  return rows.map((r) => ({ uri: r.uri, place: r.place_key, at: (r.created_at as Date).toISOString() }));
}

function sink() {
  const errors: unknown[] = [];
  return { sink: new CheckinSink(pool, (e) => errors.push(e), { flushMs: 5 }), errors };
}

test("a pin becomes a check-in for its place, with the place as published", () => {
  assert.deepEqual(toCheckin(commit("create", "3k2a", pin())), {
    uri: uri("3k2a"),
    action: "create",
    place: PLACE,
    createdAt: "2026-10-20T12:00:00.000Z",
    name: "McDonald's",
    lat: 52.48676,
    lng: 13.42456,
  });
  assert.deepEqual(toCheckin(commit("delete", "3k2a")), { uri: uri("3k2a"), action: "delete" });
});

test("what is not a countable pin is left alone", () => {
  // Another collection, account and identity events, a pin without a place ID (street
  // level), unusable dates and IDs.
  assert.equal(toCheckin({ ...commit("create", "x", pin()), commit: { ...commit("create", "x", pin()).commit, collection: "app.bsky.feed.post" } }), null);
  assert.equal(toCheckin({ did: DID, time_us: 1, kind: "identity" }), null);
  assert.equal(toCheckin(commit("create", "3k2b", pin(null))), null);
  assert.equal(toCheckin(commit("create", "3k2c", { ...pin(), createdAt: "yesterday" })), null);
  assert.equal(toCheckin(commit("create", "3k2d", pin("https://example.org/place/1"))), null);
  assert.equal(toCheckin(commit("create", "has spaces", pin())), null);
  assert.equal(toCheckin({ ...commit("create", "3k2e", pin()), did: "not-a-did" }), null);
});

test("an edit that leaves no place to count takes the check-in back", () => {
  assert.deepEqual(toCheckin(commit("update", "3k2a", pin(null))), { uri: uri("3k2a"), action: "delete" });
  assert.equal(toCheckin(commit("update", "3k2a", pin()))?.action, "create");
});

test("the sink records check-ins and deletions and remembers where it got to", async () => {
  const { sink: s, errors } = sink();
  s.push(JSON.stringify(commit("create", "a", pin(), 100)));
  s.push(JSON.stringify(commit("create", "b", pin("urn:atgeo:openstreetmap.org:node:5171026793"), 200)));
  s.push("not json");
  s.push(JSON.stringify({ did: DID, time_us: 250, kind: "account" }));
  await s.flush();
  assert.deepEqual((await rows()).map((r) => r.uri), [uri("a"), uri("b")]);
  assert.equal(await readCursor(pool), 250);

  s.push(JSON.stringify(commit("delete", "a", undefined, 300)));
  await s.flush();
  assert.deepEqual((await rows()).map((r) => r.uri), [uri("b")]);
  assert.equal(await readCursor(pool), 300);
  assert.deepEqual(s.totals, { created: 2, deleted: 1 });
  assert.deepEqual(errors, []);
});

test("within one batch the last word on a record wins", async () => {
  const { sink: s } = sink();
  s.push(JSON.stringify(commit("create", "a", pin(), 100)));
  s.push(JSON.stringify(commit("delete", "a", undefined, 101)));
  s.push(JSON.stringify(commit("create", "b", pin(), 102)));
  s.push(JSON.stringify(commit("update", "b", pin("urn:atgeo:overturemaps.org:place:adc6176b-5d09-4dac-89a7-3649b18e525e"), 103)));
  await s.flush();
  assert.deepEqual(await rows(), [
    { uri: uri("b"), place: "urn:atgeo:overturemaps.org:place:adc6176b-5d09-4dac-89a7-3649b18e525e", at: "2026-10-20T12:00:00.000Z" },
  ]);
});

test("replaying the stream after a restart records nothing twice, and the cursor never goes back", async () => {
  const first = sink().sink;
  first.push(JSON.stringify(commit("create", "a", pin(), 500)));
  await first.flush();
  const replay = sink().sink;
  replay.push(JSON.stringify(commit("create", "a", pin(), 400)));
  replay.push(JSON.stringify(commit("create", "a", pin(), 500)));
  await replay.flush();
  assert.equal((await rows()).length, 1);
  assert.equal(await readCursor(pool), 500);
});

test("messages are written after a short wait, or at once when many are waiting", async () => {
  const timed = new CheckinSink(pool, () => {}, { flushMs: 20 });
  timed.push(JSON.stringify(commit("create", "a", pin(), 1)));
  assert.equal((await rows()).length, 0);
  // Written without anyone calling flush(): wait for it rather than for a fixed time,
  // which a busy machine overshoots.
  const deadline = Date.now() + 3_000;
  while ((await rows()).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await rows()).length, 1);

  const full = new CheckinSink(pool, () => {}, { flushMs: 60_000, maxBatch: 2 });
  full.push(JSON.stringify(commit("create", "b", pin(), 2)));
  full.push(JSON.stringify(commit("create", "c", pin(), 3)));
  await full.flush();
  assert.equal((await rows()).length, 3);
});

test("a failed write is reported once and stops the sink, so the connection starts over", async () => {
  const errors: unknown[] = [];
  const broken = { query: async () => Promise.reject(new Error("db gone")), connect: async () => Promise.reject(new Error("db gone")) };
  const s = new CheckinSink(broken as unknown as Pool, (e) => errors.push(e), { flushMs: 5 });
  s.push(JSON.stringify(commit("create", "a", pin(), 1)));
  await s.flush();
  s.push(JSON.stringify(commit("create", "b", pin(), 2)));
  await s.flush();
  assert.equal(errors.length, 1);
});

test("it subscribes to pins only, from where it left off", () => {
  const base = "wss://jetstream1.eurosky.network/subscribe";
  assert.equal(subscribeUrl(base, undefined), `${base}?wantedCollections=${PIN_COLLECTION}`);
  assert.equal(subscribeUrl(base, 1_760_000_000_000_000), `${base}?wantedCollections=${PIN_COLLECTION}&cursor=1760000000000000`);
});
