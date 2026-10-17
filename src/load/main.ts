import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { duckdbSettings, huggingFaceToken, loadConfig, osm2pgsqlCacheMb } from "../config.ts";
import { createPool } from "../db.ts";
import { reattachOrphans } from "../live.ts";
import { migrate } from "../migrate.ts";
import { extractImportance, extractToStaging, foursquareCutoff, WIKIMEDIA_IMPORTANCE_URL } from "./extract.ts";
import { importOsm } from "./osm.ts";
import { buildReference, dropRollbackCopy, prepareStaging, swapReference, type BBox } from "./reference.ts";
import {
  downloadFoursquare,
  foursquarePath,
  latestFoursquareRelease,
  latestOvertureRelease,
  overturePath,
} from "./releases.ts";

const USAGE = `Usage: npm run load -- (--bbox xmin,ymin,xmax,ymax | --worldwide) [--osm <file.osm.pbf>] [options]

  --bbox            load only this area (development), e.g. Berlin: 13.08,52.33,13.76,52.68
  --worldwide       load everything (production host only: ~25 GB of downloads, hours of work);
                    needs --osm with the planet file
  --osm             OpenStreetMap file to import with osm2pgsql (optional with --bbox),
                    e.g. https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
  --osm-flat-nodes  file for osm2pgsql's node positions instead of memory. Rarely useful: the
                    input is filtered with osmium first, and OSM2PGSQL_CACHE_MB (a few GB)
                    holds the filtered planet's nodes
  --wikimedia       Wikipedia importance file, path or URL (default: Nominatim's, ~320 MB)
  --overture        Overture release, e.g. 2026-09-23.1 (default: newest complete)
  --foursquare      Foursquare release, e.g. 2026-09-15 (default: newest complete)`;

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
      osm: { type: "string" },
      wikimedia: { type: "string" },
      "osm-flat-nodes": { type: "string" },
    },
  });
  // A worldwide load must be asked for explicitly, so a forgotten flag cannot start a
  // multi-hour, multi-GB download on a laptop. It also needs OpenStreetMap: without it the
  // new release would silently lose every OSM place.
  if (!values.bbox === !values.worldwide || (values.worldwide && !values.osm)) {
    console.error(USAGE);
    process.exit(2);
  }
  const bbox = values.bbox ? parseBBox(values.bbox) : null;
  const config = loadConfig();
  const duckdb = duckdbSettings();
  const token = huggingFaceToken();
  const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
    const overtureRelease = values.overture ?? (await latestOvertureRelease());
    const foursquareRelease = values.foursquare ?? (await latestFoursquareRelease(token));
    log(`Overture ${overtureRelease}, Foursquare ${foursquareRelease}, ${bbox ? `bbox ${bbox.join(",")}` : "worldwide"}`);

    if (await dropRollbackCopy(pool)) log("dropped the previous release's rollback copy (ref_prev) to make room");
    await prepareStaging(pool);

    // A worldwide load reads every Foursquare file in full, so it downloads them whole
    // first: Hugging Face rate-limits the small range reads DuckDB would make instead. An
    // area load reads only a few parts of each file and stays remote.
    let foursquarePlaces = foursquarePath(foursquareRelease);
    const foursquareDir = bbox ? undefined : await mkdtemp(join(duckdb.tempDirectory ?? tmpdir(), "foursquare-"));
    let extracted: Record<string, number>;
    try {
      if (foursquareDir) {
        const started = Date.now();
        const download = await downloadFoursquare({ release: foursquareRelease, token, dir: foursquareDir });
        const gb = (download.bytes / 1e9).toFixed(1);
        log(`Foursquare ${foursquareRelease}: downloaded ${download.files} files, ${gb} GB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
        foursquarePlaces = download.glob;
      }
      extracted = await extractToStaging({
        databaseUrl: config.databaseUrl,
        paths: {
          overturePlaces: overturePath(overtureRelease, "places"),
          overtureDivisions: overturePath(overtureRelease, "divisions"),
          overtureAreas: overturePath(overtureRelease, "areas"),
          overtureAddresses: overturePath(overtureRelease, "addresses"),
          foursquarePlaces,
        },
        foursquareCutoff: foursquareCutoff(foursquareRelease),
        bbox,
        huggingFaceToken: token,
        duckdb,
        workDirectory: duckdb.tempDirectory,
        log,
      });
    } finally {
      if (foursquareDir) await rm(foursquareDir, { recursive: true, force: true });
    }
    log(`extracted ${JSON.stringify(extracted)}`);

    if (values.osm) {
      await importOsm({
        databaseUrl: config.databaseUrl,
        file: values.osm,
        cacheMb: osm2pgsqlCacheMb(),
        flatNodes: values["osm-flat-nodes"],
        workDirectory: duckdb.tempDirectory,
        log,
      });
    } else {
      log("no --osm: this release has no OpenStreetMap places or streets");
    }

    await extractImportance({ databaseUrl: config.databaseUrl, source: values.wikimedia ?? WIKIMEDIA_IMPORTANCE_URL, duckdb, log });

    const counts = await buildReference(pool);
    log(`built ${JSON.stringify(counts)}`);

    const sources: Record<string, string> = { overture: overtureRelease, foursquare: foursquareRelease };
    if (values.osm) sources.osm = basename(values.osm);
    const release = { sources, bbox };
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
