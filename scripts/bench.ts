// Times endpoint A against whatever reference data is loaded, in-process (no network).
//
//   npm run bench                                    200 random points in central Berlin
//   npm run bench -- --bbox 2.25,48.81,2.42,48.90 --n 500
//   npm run bench -- --show 52.4867,13.4245          print one full answer
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
  },
});

const pool = createPool(loadConfig().databaseUrl);
const app = buildApp({ pool });
const ask = (lat: number, lng: number) =>
  app.inject({ method: "POST", url: "/v1/suggestions", payload: { lat, lng } });

try {
  if (values.show) {
    const [lat, lng] = values.show.split(",").map(Number);
    console.log(JSON.stringify((await ask(lat!, lng!)).json(), null, 2));
  } else {
    const [xmin, ymin, xmax, ymax] = parseBBox(values.bbox);
    const points = Array.from({ length: Number(values.n) }, () => [
      ymin + Math.random() * (ymax - ymin),
      xmin + Math.random() * (xmax - xmin),
    ]);
    const timings: number[] = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: Number(values.concurrency) }, async () => {
        while (next < points.length) {
          const [lat, lng] = points[next++]!;
          const t = performance.now();
          const res = await ask(lat!, lng!);
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
} finally {
  await app.close();
  await pool.end();
}
