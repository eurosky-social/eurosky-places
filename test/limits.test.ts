import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { createPool, isBusy, type Pool } from "../src/db.ts";
import { PUBLIC_RATE_LIMITS, registerRateLimits } from "../src/limits.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/db.ts";

let pool: Pool;

before(async () => {
  pool = await freshDatabase();
});

after(async () => {
  await pool?.end();
});

const LIMITS = { ...PUBLIC_RATE_LIMITS, search: 2, squares: 3 };
const search = (app: ReturnType<typeof buildApp>, from: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/search", payload: { q: "Brandenb" }, remoteAddress: from, headers });

test("an address over its limit gets 429 with when to try again; other addresses do not", async () => {
  const app = buildApp({ pool, rateLimits: LIMITS });
  assert.notEqual((await search(app, "198.51.100.7")).statusCode, 429);
  assert.notEqual((await search(app, "198.51.100.7")).statusCode, 429);
  const refused = await search(app, "198.51.100.7");
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json().error, "RateLimited");
  assert.equal(refused.headers["access-control-allow-origin"], "*");
  assert.ok(Number(refused.headers["retry-after"]) >= 1 && Number(refused.headers["retry-after"]) <= 60);
  assert.notEqual((await search(app, "203.0.113.9")).statusCode, 429);
  // Each endpoint counts on its own; /health and preflights are not counted.
  assert.equal((await app.inject({ method: "GET", url: "/v1/squares/52.48,13.42", remoteAddress: "198.51.100.7" })).statusCode !== 429, true);
  assert.equal((await app.inject({ method: "GET", url: "/health", remoteAddress: "198.51.100.7" })).statusCode, 200);
  assert.equal((await app.inject({ method: "OPTIONS", url: "/v1/search", remoteAddress: "198.51.100.7" })).statusCode, 204);
  await app.close();
});

test("behind the edge on this host the forwarded address counts, and a client cannot set its own", async () => {
  const app = buildApp({ pool, rateLimits: LIMITS });
  const viaEdge = (client: string) => search(app, "127.0.0.1", { "x-forwarded-for": client });
  await viaEdge("198.51.100.20");
  await viaEdge("198.51.100.20");
  assert.equal((await viaEdge("198.51.100.20")).statusCode, 429);
  assert.notEqual((await viaEdge("198.51.100.21")).statusCode, 429);
  // From anywhere else X-Forwarded-For is ignored: rotating it does not reset the count.
  const direct = (spoofed: string) => search(app, "192.0.2.50", { "x-forwarded-for": spoofed });
  await direct("10.0.0.1");
  await direct("10.0.0.2");
  assert.equal((await direct("10.0.0.3")).statusCode, 429);
  await app.close();
});

test("a window ends after a minute", async () => {
  let clock = 0;
  const app = Fastify();
  registerRateLimits(app, { ...PUBLIC_RATE_LIMITS, search: 1 }, () => clock);
  app.post("/v1/search", async () => ({ ok: true }));
  const ask = () => app.inject({ method: "POST", url: "/v1/search", remoteAddress: "198.51.100.30" });
  assert.equal((await ask()).statusCode, 200);
  assert.equal((await ask()).statusCode, 429);
  clock = 60_001;
  assert.equal((await ask()).statusCode, 200);
  await app.close();
});

test("without limits configured nothing is counted", async () => {
  const app = buildApp({ pool });
  for (let i = 0; i < 5; i++) assert.notEqual((await search(app, "198.51.100.40")).statusCode, 429);
  await app.close();
});

test("a query that runs out of time answers 503 Busy, for browsers too", async () => {
  const slow = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const stub = { query: async () => Promise.reject(slow), connect: async () => Promise.reject(slow) } as unknown as Pool;
  const lines: string[] = [];
  const app = buildApp({ pool: stub, logger: { level: "info", stream: { write: (l: string) => void lines.push(l) } } });
  const res = await app.inject({ method: "POST", url: "/v1/search", payload: { q: "Brandenb", lat: 52.4867, lng: 13.4245 } });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "Busy", message: "the service is busy; try again in a few seconds" });
  assert.equal(res.headers["retry-after"], "5");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  // The log says it was busy, nothing about the request.
  assert.equal(lines.filter((l) => l.includes("52.4867") || l.includes("Brandenb")).length, 0);
  assert.equal(lines.filter((l) => l.includes('"busy"')).length, 1);
  // Other errors still answer as before.
  const bad = await app.inject({ method: "POST", url: "/v1/search", payload: { q: "" } });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("the API's connections cancel long queries; a pool without the option does not", async () => {
  const api = createPool(TEST_DATABASE_URL, 1, { statementTimeoutMs: 50 });
  await assert.rejects(api.query("SELECT pg_sleep(0.5)"), (e: unknown) => isBusy(e));
  assert.equal((await api.query("SHOW statement_timeout")).rows[0].statement_timeout, "50ms");
  await api.end();
  assert.equal((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout, "0");
});

test("waiting for a free connection gives up as busy", async () => {
  const tiny = createPool(TEST_DATABASE_URL, 1, { connectionTimeoutMs: 100 });
  const held = await tiny.connect();
  await assert.rejects(tiny.query("SELECT 1"), (e: unknown) => isBusy(e));
  held.release();
  await tiny.end();
});
