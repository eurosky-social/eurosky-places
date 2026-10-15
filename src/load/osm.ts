import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const OSM_STYLE = fileURLToPath(new URL("./osm/places.lua", import.meta.url));

export interface OsmOptions {
  databaseUrl: string;
  // An OpenStreetMap extract or the whole planet, .osm.pbf
  file: string;
  // For the planet: osm2pgsql keeps node positions in this file (~100 GB) instead of in
  // memory. Not needed for regional extracts.
  flatNodes?: string;
  log?: (message: string) => void;
}

// Runs osm2pgsql with our style, writing ref_next.stage_osm_places and
// ref_next.stage_osm_streets. Must run after prepareStaging and before buildReference.
export async function importOsm(opts: OsmOptions): Promise<void> {
  const args = [
    "--create",
    "--output=flex",
    `--style=${OSM_STYLE}`,
    "--schema=ref_next",
    // Keep the intermediate data on disk and drop it afterwards; we never update in place.
    "--slim",
    "--drop",
    ...(opts.flatNodes ? [`--flat-nodes=${opts.flatNodes}`] : []),
    `--database=${opts.databaseUrl}`,
    opts.file,
  ];
  const binary = process.env.OSM2PGSQL ?? "osm2pgsql";
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
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
      code === 0 ? resolve() : reject(new Error(`osm2pgsql exited with ${code}:\n${tail.join("\n")}`)),
    );
  });
  opts.log?.(`OpenStreetMap ${opts.file}: imported in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
