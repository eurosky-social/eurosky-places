// Times the endpoints against whatever reference data is loaded, in-process (no network).
//
//   npm run bench                                    endpoint A: 200 random points in central Berlin
//   npm run bench -- --bbox 2.25,48.81,2.42,48.90 --n 500
//   npm run bench -- --show 52.4867,13.4245          print one full endpoint A answer
//   npm run bench -- --search                        type-ahead: real names typed letter by letter
//   npm run bench -- --search --show "Brandenb@52.4867,13.4245"
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { parseBBox } from "../src/load/main.ts";
import { buildApp } from "../src/server.ts";

const { values } = parseArgs({
  options: {
    bbox: { type: "string", default: "13.30,52.46,13.50,52.56" },
    n: { type: "string", default: "200" },
    concurrency: { type: "string", default: "1" },
    show: { type: "string" },
    search: { type: "boolean", default: false },
  },
});

const pool = createPool(loadConfig().databaseUrl);
const app = buildApp({ pool });
const suggest = (lat: number, lng: number) =>
  app.inject({ method: "POST", url: "/v1/suggestions", payload: { lat, lng } });
const search = (q: string, lat?: number, lng?: number) =>
  app.inject({ method: "POST", url: "/v1/search", payload: lat === undefined ? { q } : { q, lat, lng } });

async function time(requests: Array<() => Promise<{ statusCode: number; body: string }>>) {
  const timings: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Number(values.concurrency) }, async () => {
      while (next < requests.length) {
        const request = requests[next++]!;
        const t = performance.now();
        const res = await request();
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${res.body}`);
        timings.push(performance.now() - t);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  timings.sort((a, b) => a - b);
  const at = (q: number) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))]!.toFixed(1);
  console.log(
    `${timings.length} requests, concurrency ${values.concurrency}: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, ` +
      `max ${at(1)} ms, ${(timings.length / elapsed).toFixed(0)} requests/s`,
  );
}

try {
  const [xmin, ymin, xmax, ymax] = parseBBox(values.bbox);
  const randomPoint = () => [ymin + Math.random() * (ymax - ymin), xmin + Math.random() * (xmax - xmin)] as const;

  if (values.search && values.show) {
    const [q, at] = values.show.split("@");
    const [lat, lng] = at ? at.split(",").map(Number) : [];
    console.log(JSON.stringify((await search(q!, lat, lng)).json(), null, 2));
  } else if (values.search) {
    // Real names from the loaded data, typed one letter at a time from the second letter on.
    const { rows } = await pool.query(
      `SELECT name FROM ref.places TABLESAMPLE SYSTEM (1) WHERE length(name) >= 6 LIMIT $1`,
      [Math.ceil(Number(values.n) / 6)],
    );
    const requests = rows.flatMap(({ name }) => {
      const [lat, lng] = randomPoint();
      return Array.from({ length: Math.min(8, name.length) - 1 }, (_, i) => () => search(name.slice(0, i + 2), lat, lng));
    });
    await time(requests.slice(0, Number(values.n)));
  } else if (values.show) {
    const [lat, lng] = values.show.split(",").map(Number);
    console.log(JSON.stringify((await suggest(lat!, lng!)).json(), null, 2));
  } else {
    await time(
      Array.from({ length: Number(values.n) }, () => {
        const [lat, lng] = randomPoint();
        return () => suggest(lat, lng);
      }),
    );
  }
} finally {
  await app.close();
  await pool.end();
}
