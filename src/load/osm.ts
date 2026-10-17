import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const OSM_STYLE = fileURLToPath(new URL("./osm/places.lua", import.meta.url));

// The tags places.lua looks at: the keys in its KEYS list, plus highway for streets.
// Every place and every street it keeps has one of them and a name, so filtering the
// input on both first throws away nothing the style would keep. A test checks this list
// against the style.
export const OSM_FILTER_KEYS = [
  "amenity", "tourism", "shop", "leisure", "historic", "railway", "public_transport", "aeroway",
  "natural", "waterway", "man_made", "place", "office", "craft", "healthcare", "highway",
];

export interface OsmOptions {
  databaseUrl: string;
  // An OpenStreetMap extract or the whole planet, .osm.pbf
  file: string;
  // Filter the input with osmium first (default). Only tests turn it off, to show
  // that it changes nothing.
  filter?: boolean;
  // osm2pgsql's node position cache in MB (--cache, default 800). The filtered planet's
  // nodes need a few GB; when they do not fit, osm2pgsql looks them up in Postgres.
  cacheMb?: number;
  // osm2pgsql keeps node positions in this file instead of in memory. Unfiltered, the
  // planet needs it (~100 GB), and it is slow wherever the file does not fit in the page
  // cache: every way's nodes are random reads.
  flatNodes?: string;
  // Where the filtered copy goes (default: the OS temp directory); removed afterwards.
  workDirectory?: string;
  log?: (message: string) => void;
}

// Runs a command, failing with the tail of its stderr.
function run(binary: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    const tail: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    });
    child.on("error", (error) => reject(new Error(`could not run ${binary}: ${error.message}`)));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${binary} exited with ${code}:\n${tail.join("\n")}`)),
    );
  });
}

// Copies what places.lua can use out of an OpenStreetMap file, in two osmium passes:
// objects with one of OSM_FILTER_KEYS, then of those the named ones. osmium adds the
// nodes of every way it keeps and the members of every relation (and their nodes), so
// outlines and centroids come out the same. Most of the planet (buildings, land use,
// unnamed roads, boundaries) never reaches osm2pgsql.
export async function filterOsm(file: string, dir: string): Promise<string> {
  const osmium = process.env.OSMIUM ?? "osmium";
  const keyed = join(dir, "keyed.osm.pbf");
  const named = join(dir, "named.osm.pbf");
  await run(osmium, ["tags-filter", file, ...OSM_FILTER_KEYS.map((k) => `nwr/${k}`), "-o", keyed, "--overwrite"]);
  await run(osmium, ["tags-filter", keyed, "nwr/name", "-o", named, "--overwrite"]);
  await rm(keyed, { force: true });
  return named;
}

const seconds = (from: number) => ((Date.now() - from) / 1000).toFixed(0);

// Runs osm2pgsql with our style, writing ref_next.stage_osm_places and
// ref_next.stage_osm_streets. Must run after prepareStaging and before buildReference.
export async function importOsm(opts: OsmOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const dir = await mkdtemp(join(opts.workDirectory ?? tmpdir(), "osm-"));
  try {
    let input = opts.file;
    if (opts.filter ?? true) {
      const started = Date.now();
      input = await filterOsm(opts.file, dir);
      const mb = Math.round((await stat(input)).size / 1e6).toLocaleString("en");
      log(`OpenStreetMap ${opts.file}: filtered to ${mb} MB in ${seconds(started)} s`);
    }
    const started = Date.now();
    await run(process.env.OSM2PGSQL ?? "osm2pgsql", [
      "--create",
      "--output=flex",
      `--style=${OSM_STYLE}`,
      "--schema=ref_next",
      // Keep the intermediate data on disk and drop it afterwards; we never update in place.
      "--slim",
      "--drop",
      ...(opts.cacheMb ? [`--cache=${opts.cacheMb}`] : []),
      ...(opts.flatNodes ? [`--flat-nodes=${opts.flatNodes}`] : []),
      `--database=${opts.databaseUrl}`,
      input,
    ]);
    log(`OpenStreetMap ${opts.file}: imported in ${seconds(started)} s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
