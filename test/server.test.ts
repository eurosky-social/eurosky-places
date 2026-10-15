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
