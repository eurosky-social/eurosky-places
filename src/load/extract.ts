import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { DuckDBSettings } from "../config.ts";
import { categoryGroupMacroSql, nonVenueMacroSql } from "../places/categories.ts";
import { DATASETS } from "../places/origin.ts";
import type { BBox } from "./reference.ts";

// Where each source's Parquet files are; a glob, local or remote (s3://, hf://).
export interface SourcePaths {
  overturePlaces: string;
  overtureDivisions: string;
  overtureAreas: string;
  overtureAddresses: string;
  foursquarePlaces: string;
}

export interface ExtractOptions {
  databaseUrl: string;
  paths: SourcePaths;
  // Foursquare places last confirmed before this date (YYYY-MM-DD) are skipped.
  foursquareCutoff: string;
  // Restricts the load to an area, for development; null loads the whole world.
  bbox: BBox | null;
  huggingFaceToken?: string;
  duckdb?: DuckDBSettings;
  // Where each source's rows are copied before they go into Postgres (default: the OS
  // temp directory). Worldwide the largest copy, the addresses, is a few GB.
  workDirectory?: string;
  log?: (message: string) => void;
}

const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Rows whose bounding box intersects the requested area.
function bboxFilter(bbox: BBox | null, x: { xmin: string; xmax: string; ymin: string; ymax: string }): string {
  if (!bbox) return "true";
  const [xmin, ymin, xmax, ymax] = bbox;
  return `${x.xmin} <= ${xmax} AND ${x.xmax} >= ${xmin} AND ${x.ymin} <= ${ymax} AND ${x.ymax} >= ${ymin}`;
}

const OVERTURE_BBOX = { xmin: "bbox.xmin", xmax: "bbox.xmax", ymin: "bbox.ymin", ymax: "bbox.ymax" };
const FOURSQUARE_BBOX = { xmin: "longitude", xmax: "longitude", ymin: "latitude", ymax: "latitude" };

// Foursquare keeps places for years after anyone last confirmed them; only places
// confirmed in the two years before the release count as current.
export function foursquareCutoff(release: string): string {
  const d = new Date(`${release}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

// One source's rows for one staging table: a SELECT over the source files whose output
// columns are named like the table's.
export interface Extraction {
  label: string;
  table: string;
  columns: string[];
  select: string;
  // Rows to leave out that can only be told once all rows are known: a condition over the
  // local copy of the selected rows (`file`) that is true for them. `why` goes in the log.
  leaveOut?: { why: string; where: (file: string) => string };
}

const PLACE_COLUMNS = ["dataset", "collection", "id", "name", "category", "category_group", "confidence", "lon", "lat", "unconfirmed"];

// Overture places whose source only knew the town or district are put at that area's
// reference point, all of them on the very same coordinates: 428 records at one point in
// central Nairobi (Tsavo West National Park and Mombasa's station among them), 86 at
// Shibuya's ward office (EUR-480). A point shared by this many Overture records is such a
// pile-up; a building's shops share a point a few at a time (Tokyu Plaza Shibuya: 8).
export const PILE_UP_RECORDS = 21;

export function overturePlaces(source: string, bbox: BBox | null): Extraction {
  return {
    label: "Overture places",
    table: "stage_places",
    columns: PLACE_COLUMNS,
    select: `
      SELECT ${lit(DATASETS.overture)} AS dataset, 'place' AS collection, id, names.primary AS name,
             basic_category AS category,
             category_group(concat_ws(' ', basic_category, array_to_string(taxonomy.hierarchy, ' > '))) AS category_group,
             confidence, (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat,
             -- Placed by its town or district alone: only Meta vouches for it (Overture's
             -- own entries aside) and its address has no street. The Ajinomoto Stadium
             -- ("渋谷区", 15 km from the stadium) and Dal Lake (at Mumbai's main station)
             -- are such records. Suggestions show them only next to a twin from another
             -- source.
             len(list_filter(sources, s -> s.dataset <> 'meta' AND NOT starts_with(s.dataset, 'Overture'))) = 0
               AND coalesce(len(list_filter(addresses, a -> a.freeform IS NOT NULL)), 0) = 0 AS unconfirmed
      FROM read_parquet(${lit(source)})
      WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}
        AND names.primary IS NOT NULL
        AND coalesce(operating_status, 'open') = 'open'
        AND confidence >= 0.5
        -- Company-registry records (BrightQuery, since 2026-09) are legal entities at their
        -- registered address, not venues. Keep a record only if another source confirms it.
        AND len(list_filter(sources, s -> s.dataset NOT IN ('BrightQuery', 'Overture'))) > 0
        -- Parking, cash machines, homes, … (NON_VENUES in src/places/categories.ts)
        AND NOT overture_non_venue(list_append(coalesce(taxonomy.hierarchy, []::VARCHAR[]), basic_category))`,
    leaveOut: {
      why: `pile-ups of ${PILE_UP_RECORDS}+ at one point`,
      where: (file) => `(lon, lat) IN (
        SELECT lon, lat FROM read_parquet(${lit(file)}) GROUP BY lon, lat HAVING count(*) >= ${PILE_UP_RECORDS})`,
    },
  };
}

// A Foursquare place can have several category labels. Labels of things that are not
// venues (NON_VENUES) are dropped, and a place left with none is skipped; its category is
// its first remaining label. Places without any label are kept.
export function foursquarePlaces(source: string, cutoff: string, bbox: BBox | null): Extraction {
  return {
    label: "Foursquare places",
    table: "stage_places",
    columns: PLACE_COLUMNS,
    select: `
      SELECT ${lit(DATASETS.foursquare)} AS dataset, 'place' AS collection, fsq_place_id AS id, name,
             list_last(string_split(venue_labels[1], ' > ')) AS category,
             category_group(venue_labels[1]) AS category_group,
             NULL::FLOAT AS confidence, longitude AS lon, latitude AS lat, false AS unconfirmed
      FROM (
        SELECT *, list_filter(fsq_category_labels, l -> NOT foursquare_non_venue(l)) AS venue_labels
        FROM read_parquet(${lit(source)})
        WHERE ${bboxFilter(bbox, FOURSQUARE_BBOX)}
          AND name IS NOT NULL AND longitude IS NOT NULL AND latitude IS NOT NULL
          AND date_closed IS NULL
          AND date_refreshed >= ${lit(cutoff)}
          -- Foursquare's own doubts about a record: closed, duplicate, doesnt_exist, …
          AND coalesce(len(unresolved_flags), 0) = 0
      )
      WHERE coalesce(len(venue_labels), 0) > 0 OR coalesce(len(fsq_category_labels), 0) = 0`,
  };
}

export function overtureAreas(source: string, bbox: BBox | null): Extraction {
  return {
    label: "Overture boundaries",
    table: "stage_areas",
    columns: ["division_id", "subtype", "name", "country", "wkb"],
    select: `
      SELECT division_id, subtype, names.primary AS name, country, ST_AsWKB(geometry)::BLOB AS wkb
      FROM read_parquet(${lit(source)})
      WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}
        AND class = 'land' AND names.primary IS NOT NULL`,
  };
}

export function overtureDivisions(source: string, bbox: BBox | null): Extraction {
  return {
    label: "Overture divisions",
    table: "stage_divisions",
    columns: ["division_id", "wikidata", "population", "names"],
    select: `
      SELECT id AS division_id, wikidata, population, to_json(names.common)::VARCHAR AS names
      FROM read_parquet(${lit(source)})
      WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}`,
  };
}

// The Nominatim project's Wikipedia importance (https://nominatim.org/data/): one row per
// article or redirect, 0–1, with the article's Wikidata ID. Only IDs that some staged
// place or area has are kept, as their highest importance.
export const WIKIMEDIA_IMPORTANCE_URL = "https://nominatim.org/data/wikimedia-importance.csv.gz";

export function importanceSql(source: string): string {
  return `
    INSERT INTO pg.ref_next.stage_importance (wikidata, importance)
    SELECT wikidata_id, max(importance)
    FROM read_csv(${lit(source)}, delim = '\t', header = true, quote = '', escape = '',
                  columns = {'language': 'VARCHAR', 'type': 'VARCHAR', 'title': 'VARCHAR',
                             'importance': 'DOUBLE', 'wikidata_id': 'VARCHAR'})
    WHERE wikidata_id IN (
      SELECT wikidata FROM pg.ref_next.stage_osm_places WHERE wikidata IS NOT NULL
      UNION SELECT wikidata FROM pg.ref_next.stage_divisions WHERE wikidata IS NOT NULL
      UNION SELECT wikidata FROM pg.ref_next.stage_places WHERE wikidata IS NOT NULL
    )
    GROUP BY wikidata_id`;
}

export function overtureAddresses(source: string, bbox: BBox | null): Extraction {
  return {
    label: "Overture addresses",
    table: "stage_addresses",
    columns: ["street", "number", "postcode", "lon", "lat"],
    select: `
      SELECT street, number, postcode, (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat
      FROM read_parquet(${lit(source)})
      WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}
        AND street IS NOT NULL`,
  };
}

// An in-memory DuckDB that can read remote Parquet and write into our Postgres as `pg`.
export async function openDuckDB(databaseUrl: string, huggingFaceToken?: string, settings: DuckDBSettings = {}) {
  const options: Record<string, string> = {};
  if (settings.memoryLimit) options.memory_limit = settings.memoryLimit;
  if (settings.tempDirectory) options.temp_directory = settings.tempDirectory;
  // Row order means nothing here (the build sorts everything), and keeping it would hold
  // back the parallel writes the extraction relies on.
  options.preserve_insertion_order = "false";
  const instance = await DuckDBInstance.create(":memory:", options);
  const con = await instance.connect();
  await con.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; INSTALL postgres; LOAD postgres");
  await con.run("SET s3_region = 'us-west-2'");
  // A worldwide extraction makes tens of thousands of requests over most of an hour;
  // ride out a throttled or failing one for up to ~2 minutes instead of losing the load.
  await con.run("SET http_retries = 8; SET http_retry_wait_ms = 500; SET http_retry_backoff = 2");
  if (huggingFaceToken) await con.run(`CREATE SECRET hf (TYPE huggingface, TOKEN ${lit(huggingFaceToken)})`);
  await con.run(`ATTACH ${lit(databaseUrl)} AS pg (TYPE postgres)`);
  await con.run(categoryGroupMacroSql());
  await con.run(nonVenueMacroSql());
  return {
    con,
    close() {
      con.closeSync();
      instance.closeSync();
    },
  };
}

const seconds = (from: number, to = Date.now()) => ((to - from) / 1000).toFixed(0);

async function timed(con: DuckDBConnection, label: string, query: string, log: (m: string) => void): Promise<number> {
  const started = Date.now();
  const rows = Number((await con.run(query)).rowsChanged);
  log(`${label}: ${rows.toLocaleString("en")} rows in ${seconds(started)} s`);
  return rows;
}

// Wikipedia prominence for the Wikidata IDs in the staging tables. Runs after the
// OpenStreetMap import, which brings most of the IDs.
export async function extractImportance(opts: {
  databaseUrl: string;
  source: string;
  duckdb?: DuckDBSettings;
  log?: (message: string) => void;
}): Promise<number> {
  const duck = await openDuckDB(opts.databaseUrl, undefined, opts.duckdb);
  try {
    // nominatim.org refuses requests without an identifying User-Agent.
    await duck.con.run(
      "CREATE SECRET ua (TYPE http, EXTRA_HTTP_HEADERS MAP {'User-Agent': 'eurosky-places (https://github.com/eurosky-social/eurosky-places)'})",
    );
    return await timed(duck.con, "Wikipedia importance", importanceSql(opts.source), opts.log ?? (() => {}));
  } finally {
    duck.close();
  }
}

// Copies an extraction's rows to a local Parquet file, then inserts that file into
// Postgres. Writing into Postgres is a single COPY stream, and DuckDB runs a query no
// wider than where its rows go, so reading the sources straight into Postgres waited on
// one remote request at a time: ~5,500 rows/s from S3 in Oregon to the production host
// in Germany. Writing a Parquet file runs on every thread: ~70,000 rows/s for the same
// read, after which the insert is a local copy.
async function stage(con: DuckDBConnection, e: Extraction, workDir: string, log: (m: string) => void): Promise<number> {
  const file = join(workDir, `${e.label.toLowerCase().replaceAll(/\W+/g, "-")}.parquet`);
  const columns = e.columns.join(", ");
  const started = Date.now();
  try {
    await con.run(`COPY (${e.select}) TO ${lit(file)} (FORMAT parquet)`);
    const copied = Date.now();
    const where = e.leaveOut ? `WHERE NOT (${e.leaveOut.where(file)})` : "";
    const result = await con.run(
      `INSERT INTO pg.ref_next.${e.table} (${columns}) SELECT ${columns} FROM read_parquet(${lit(file)}) ${where}`,
    );
    const rows = Number(result.rowsChanged);
    let left = "";
    if (e.leaveOut) {
      const all = Number((await con.runAndReadAll(`SELECT count(*) FROM read_parquet(${lit(file)})`)).getRows()[0]![0]);
      left = `, ${(all - rows).toLocaleString("en")} left out as ${e.leaveOut.why}`;
    }
    log(
      `${e.label}: ${rows.toLocaleString("en")} rows in ${seconds(started)} s ` +
        `(reading ${seconds(started, copied)} s, writing ${seconds(copied)} s${left})`,
    );
    return rows;
  } finally {
    await rm(file, { force: true });
  }
}

// Reads the source Parquet files and writes the filtered rows into ref_next's staging
// tables (created by prepareStaging).
export async function extractToStaging(opts: ExtractOptions): Promise<Record<string, number>> {
  const { paths, bbox } = opts;
  const log = opts.log ?? (() => {});
  const workDir = await mkdtemp(join(opts.workDirectory ?? tmpdir(), "extract-"));
  const duck = await openDuckDB(opts.databaseUrl, opts.huggingFaceToken, opts.duckdb);
  try {
    const run = (e: Extraction) => stage(duck.con, e, workDir, log);
    return {
      overture_places: await run(overturePlaces(paths.overturePlaces, bbox)),
      foursquare_places: await run(foursquarePlaces(paths.foursquarePlaces, opts.foursquareCutoff, bbox)),
      divisions: await run(overtureDivisions(paths.overtureDivisions, bbox)),
      areas: await run(overtureAreas(paths.overtureAreas, bbox)),
      addresses: await run(overtureAddresses(paths.overtureAddresses, bbox)),
    };
  } finally {
    duck.close();
    await rm(workDir, { recursive: true, force: true });
  }
}
