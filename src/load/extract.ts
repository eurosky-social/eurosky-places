import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { categoryGroupMacroSql } from "../places/categories.ts";
import { DATASETS } from "../places/origin.ts";
import type { BBox } from "./reference.ts";

// Where each source's Parquet files are; a glob, local or remote (s3://, hf://).
export interface SourcePaths {
  overturePlaces: string;
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

export function overturePlacesSql(source: string, bbox: BBox | null): string {
  return `
    INSERT INTO pg.ref_next.stage_places
    SELECT ${lit(DATASETS.overture)}, 'place', id, names.primary, basic_category,
           category_group(concat_ws(' ', basic_category, array_to_string(taxonomy.hierarchy, ' > '))),
           confidence, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
    FROM read_parquet(${lit(source)})
    WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}
      AND names.primary IS NOT NULL
      AND coalesce(operating_status, 'open') = 'open'
      AND confidence >= 0.5
      -- Company-registry records (BrightQuery, since 2026-09) are legal entities at their
      -- registered address, not venues. Keep a record only if another source confirms it.
      AND len(list_filter(sources, s -> s.dataset NOT IN ('BrightQuery', 'Overture'))) > 0`;
}

export function foursquarePlacesSql(source: string, cutoff: string, bbox: BBox | null): string {
  return `
    INSERT INTO pg.ref_next.stage_places
    SELECT ${lit(DATASETS.foursquare)}, 'place', fsq_place_id, name,
           list_last(string_split(fsq_category_labels[1], ' > ')),
           category_group(fsq_category_labels[1]),
           NULL, longitude, latitude
    FROM read_parquet(${lit(source)})
    WHERE ${bboxFilter(bbox, FOURSQUARE_BBOX)}
      AND name IS NOT NULL AND longitude IS NOT NULL AND latitude IS NOT NULL
      AND date_closed IS NULL
      AND date_refreshed >= ${lit(cutoff)}
      -- Foursquare's own doubts about a record: closed, duplicate, doesnt_exist, …
      AND coalesce(len(unresolved_flags), 0) = 0`;
}

export function overtureAreasSql(source: string, bbox: BBox | null): string {
  return `
    INSERT INTO pg.ref_next.stage_areas
    SELECT division_id, subtype, names.primary, country, ST_AsWKB(geometry)::BLOB
    FROM read_parquet(${lit(source)})
    WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}
      AND class = 'land' AND names.primary IS NOT NULL`;
}

export function overtureAddressesSql(source: string, bbox: BBox | null): string {
  return `
    INSERT INTO pg.ref_next.stage_addresses
    SELECT street, number, postcode, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
    FROM read_parquet(${lit(source)})
    WHERE ${bboxFilter(bbox, OVERTURE_BBOX)}
      AND street IS NOT NULL`;
}

// An in-memory DuckDB that can read remote Parquet and write into our Postgres as `pg`.
export async function openDuckDB(databaseUrl: string, huggingFaceToken?: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();
  await con.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; INSTALL postgres; LOAD postgres");
  await con.run("SET s3_region = 'us-west-2'");
  if (huggingFaceToken) await con.run(`CREATE SECRET hf (TYPE huggingface, TOKEN ${lit(huggingFaceToken)})`);
  await con.run(`ATTACH ${lit(databaseUrl)} AS pg (TYPE postgres)`);
  await con.run(categoryGroupMacroSql());
  return {
    con,
    close() {
      con.closeSync();
      instance.closeSync();
    },
  };
}

async function timed(con: DuckDBConnection, label: string, query: string, log: (m: string) => void): Promise<number> {
  const started = Date.now();
  const rows = Number((await con.run(query)).rowsChanged);
  log(`${label}: ${rows.toLocaleString("en")} rows in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return rows;
}

// Reads the source Parquet files and writes the filtered rows into ref_next's staging
// tables (created by prepareStaging).
export async function extractToStaging(opts: ExtractOptions): Promise<Record<string, number>> {
  const { paths, bbox } = opts;
  const log = opts.log ?? (() => {});
  const duck = await openDuckDB(opts.databaseUrl, opts.huggingFaceToken);
  try {
    const { con } = duck;
    return {
      overture_places: await timed(con, "Overture places", overturePlacesSql(paths.overturePlaces, bbox), log),
      foursquare_places: await timed(
        con,
        "Foursquare places",
        foursquarePlacesSql(paths.foursquarePlaces, opts.foursquareCutoff, bbox),
        log,
      ),
      areas: await timed(con, "Overture boundaries", overtureAreasSql(paths.overtureAreas, bbox), log),
      addresses: await timed(con, "Overture addresses", overtureAddressesSql(paths.overtureAddresses, bbox), log),
    };
  } finally {
    duck.close();
  }
}
