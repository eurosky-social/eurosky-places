import { parseArgs } from "node:util";
import { huggingFaceToken, loadConfig } from "../config.ts";
import { createPool } from "../db.ts";
import { reattachOrphans } from "../live.ts";
import { migrate } from "../migrate.ts";
import { extractToStaging, foursquareCutoff } from "./extract.ts";
import { buildReference, prepareStaging, swapReference, type BBox } from "./reference.ts";
import { foursquarePath, latestFoursquareRelease, latestOvertureRelease, overturePath } from "./releases.ts";

const USAGE = `Usage: npm run load -- (--bbox xmin,ymin,xmax,ymax | --worldwide) [--overture <release>] [--foursquare <release>]

  --bbox        load only this area (development), e.g. Berlin: 13.08,52.33,13.76,52.68
  --worldwide   load everything (production host only: ~25 GB of downloads, hours of work)
  --overture    Overture release, e.g. 2026-09-23.1 (default: newest complete)
  --foursquare  Foursquare release, e.g. 2026-09-15 (default: newest complete)`;

export function parseBBox(value: string): BBox {
  const parts = value.split(",").map(Number);
  const [xmin, ymin, xmax, ymax] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || xmin! >= xmax! || ymin! >= ymax!) {
    throw new Error(`invalid --bbox ${JSON.stringify(value)}; expected xmin,ymin,xmax,ymax`);
  }
  return [xmin!, ymin!, xmax!, ymax!];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      bbox: { type: "string" },
      worldwide: { type: "boolean", default: false },
      overture: { type: "string" },
      foursquare: { type: "string" },
    },
  });
  // A worldwide load must be asked for explicitly, so a forgotten flag cannot start a
  // multi-hour, multi-GB download on a laptop.
  if (!values.bbox === !values.worldwide) {
    console.error(USAGE);
    process.exit(2);
  }
  const bbox = values.bbox ? parseBBox(values.bbox) : null;
  const config = loadConfig();
  const token = huggingFaceToken();
  const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
    const overtureRelease = values.overture ?? (await latestOvertureRelease());
    const foursquareRelease = values.foursquare ?? (await latestFoursquareRelease(token));
    log(`Overture ${overtureRelease}, Foursquare ${foursquareRelease}, ${bbox ? `bbox ${bbox.join(",")}` : "worldwide"}`);

    await prepareStaging(pool);
    const extracted = await extractToStaging({
      databaseUrl: config.databaseUrl,
      paths: {
        overturePlaces: overturePath(overtureRelease, "places"),
        overtureAreas: overturePath(overtureRelease, "areas"),
        overtureAddresses: overturePath(overtureRelease, "addresses"),
        foursquarePlaces: foursquarePath(foursquareRelease),
      },
      foursquareCutoff: foursquareCutoff(foursquareRelease),
      bbox,
      huggingFaceToken: token,
      log,
    });
    log(`extracted ${JSON.stringify(extracted)}`);

    const counts = await buildReference(pool);
    log(`built ${JSON.stringify(counts)}`);

    const release = { sources: { overture: overtureRelease, foursquare: foursquareRelease }, bbox };
    const hadPrevious = await swapReference(pool, release, counts);
    log(`swapped: ref now serves this release${hadPrevious ? "; the previous one is kept as ref_prev" : ""}`);

    const reattached = await reattachOrphans(pool);
    log(
      `live data on retired place IDs: ${reattached.orphans} places, ${reattached.moved.length} moved to the ` +
        `same place's new ID, ${reattached.unmatched.length} without a match (kept as they are)`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
