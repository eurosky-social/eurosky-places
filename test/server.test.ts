import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Pool } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { buildApp } from "../src/server.ts";
import { freshDatabase } from "./helpers/db.ts";

let pool: Pool;

before(async () => {
  pool = await freshDatabase();
});

after(async () => {
  await pool?.end();
});

test("migrations are idempotent", async () => {
  assert.deepEqual(await migrate(pool), []);
});

test("/health reports no release before the first load", async () => {
  const app = buildApp({ pool });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", release: null });
  await app.close();
});

test("requests are not written to the log", async () => {
  const lines: string[] = [];
  const stream = { write: (line: string) => void lines.push(line) };
  const app = buildApp({ pool, logger: { level: "trace", stream } });
  await app.inject({ method: "GET", url: "/health?lat=52.4867&lng=13.4245" });
  await app.inject({ method: "GET", url: "/nowhere?lat=52.4867&lng=13.4245" });
  await app.close();
  assert.deepEqual(lines.filter((l) => l.includes("52.4867")), []);
});

test("web apps on any origin may call the public endpoints, errors included", async () => {
  const app = buildApp({ pool, internalToken: "secret" });
  const preflight = (url: string, method: string) =>
    app.inject({
      method: "OPTIONS",
      url,
      headers: { origin: "https://app.example", "access-control-request-method": method, "access-control-request-headers": "content-type" },
    });
  for (const [url, method] of [["/v1/suggestions", "POST"], ["/v1/search", "POST"], ["/v1/squares/52.48,13.42", "GET"]] as const) {
    const res = await preflight(url, method);
    assert.equal(res.statusCode, 204, url);
    assert.equal(res.headers["access-control-allow-origin"], "*", url);
    assert.equal(res.headers["access-control-allow-methods"], method, url);
    assert.equal(res.headers["access-control-allow-headers"], "content-type", url);
    assert.equal(res.headers["access-control-max-age"], "86400", url);
    assert.equal(res.headers["access-control-allow-credentials"], undefined, url);
  }
  // Before any data load (503) and refused requests (400) carry the header too.
  const answers = [
    await app.inject({ method: "POST", url: "/v1/suggestions", payload: { lat: 52.4867, lng: 13.4245 } }),
    await app.inject({ method: "POST", url: "/v1/suggestions", payload: { lat: 95, lng: 13.4245 } }),
    await app.inject({ method: "POST", url: "/v1/search", payload: { q: "Berlin" } }),
    await app.inject({ method: "POST", url: "/v1/search", payload: { q: "" } }),
    await app.inject({ method: "GET", url: "/v1/squares/52.48,13.42" }),
    await app.inject({ method: "GET", url: "/v1/squares/52.4867,13.4245" }),
  ];
  assert.deepEqual(
    answers.map((r) => `${r.statusCode} ${r.headers["access-control-allow-origin"]}`),
    ["503 *", "400 *", "503 *", "400 *", "503 *", "400 *"],
  );
  // Internal routes stay closed to browsers.
  const internal = await preflight("/internal/overrides", "GET");
  assert.equal(internal.statusCode, 404);
  assert.equal(internal.headers["access-control-allow-origin"], undefined);
  const overrides = await app.inject({ method: "GET", url: "/internal/overrides", headers: { authorization: "Bearer secret" } });
  assert.equal(overrides.statusCode, 200);
  assert.equal(overrides.headers["access-control-allow-origin"], undefined);
  await app.close();
});

test("/health reports the newest release", async () => {
  await pool.query(
    `INSERT INTO meta.releases (sources, bbox, counts) VALUES
       ('{"overture": "2026-08-19.0"}', NULL, '{"places": 1}'),
       ('{"overture": "2026-09-23.1"}', NULL, '{"places": 2}')`,
  );
  const app = buildApp({ pool });
  const body = (await app.inject({ method: "GET", url: "/health" })).json();
  assert.deepEqual(body.release.sources, { overture: "2026-09-23.1" });
  assert.deepEqual(body.release.counts, { places: 2 });
  await app.close();
});
