import type { Pool } from "../../src/db.ts";
import type { CategoryGroup } from "../../src/places/categories.ts";
import { buildReference, prepareStaging, swapReference } from "../../src/load/reference.ts";

// Fixtures are placed relative to Hermannplatz, in metres.
export const HERE = { lat: 52.4867, lng: 13.4245 };

export function offset(north: number, east: number): { lat: number; lng: number } {
  return {
    lat: HERE.lat + north / 111_320,
    lng: HERE.lng + east / (111_320 * Math.cos((HERE.lat * Math.PI) / 180)),
  };
}

export interface FixturePlace {
  dataset: string;
  // For openstreetmap.org: a number, loaded as a node through osm2pgsql's staging table.
  id: string;
  name: string;
  category?: string;
  group: CategoryGroup;
  north: number;
  east: number;
  wikidata?: string;
  // Wikipedia importance for `wikidata`, 0–1.
  importance?: number;
  // Other names (OpenStreetMap places only), e.g. { en: "Brandenburg Gate" }.
  names?: Record<string, string>;
  // Only Meta vouches for its position (Overture places only).
  unconfirmed?: boolean;
}

export interface FixtureArea {
  id: string;
  subtype: string;
  name: string;
  country?: string;
  wkt: string;
  wikidata?: string;
  importance?: number;
  population?: number;
  // Other names, e.g. { en: "Munich" }.
  names?: Record<string, string>;
}

export interface FixtureAddress {
  street: string;
  number?: string;
  north: number;
  east: number;
}

// Loads reference data the way a real load does (staging tables, build, swap), without
// DuckDB or source files.
export async function loadFixtures(
  pool: Pool,
  data: { places?: FixturePlace[]; areas?: FixtureArea[]; addresses?: FixtureAddress[] },
): Promise<void> {
  await prepareStaging(pool);
  const importance = new Map<string, number>();
  for (const p of data.places ?? []) {
    const { lat, lng } = offset(p.north, p.east);
    if (p.wikidata && p.importance !== undefined) importance.set(p.wikidata, p.importance);
    if (p.dataset === "openstreetmap.org") {
      // The way osm2pgsql delivers them; the build maps the category to its group.
      await pool.query(
        `INSERT INTO ref_next.stage_osm_places (osm_type, osm_id, name, category, wikidata, names, geom)
         VALUES ('N', $1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326))`,
        [Number(p.id), p.name, p.category ?? "tourism=attraction", p.wikidata ?? null, p.names ?? null, lng, lat],
      );
      continue;
    }
    await pool.query(
      `INSERT INTO ref_next.stage_places (dataset, collection, id, name, category, category_group, lon, lat, wikidata, unconfirmed)
       VALUES ($1, 'place', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [p.dataset, p.id, p.name, p.category ?? null, p.group, lng, lat, p.wikidata ?? null, p.unconfirmed ?? false],
    );
  }
  for (const a of data.areas ?? []) {
    if (a.wikidata && a.importance !== undefined) importance.set(a.wikidata, a.importance);
    await pool.query(
      `INSERT INTO ref_next.stage_areas (division_id, subtype, name, country, wkb)
       VALUES ($1, $2, $3, $4, ST_AsBinary(ST_GeomFromText($5, 4326)))`,
      [a.id, a.subtype, a.name, a.country ?? null, a.wkt],
    );
    await pool.query(
      "INSERT INTO ref_next.stage_divisions (division_id, wikidata, population, names) VALUES ($1, $2, $3, $4)",
      [a.id, a.wikidata ?? null, a.population ?? null, a.names ? JSON.stringify(a.names) : null],
    );
  }
  for (const [wikidata, value] of importance) {
    await pool.query("INSERT INTO ref_next.stage_importance (wikidata, importance) VALUES ($1, $2)", [wikidata, value]);
  }
  for (const a of data.addresses ?? []) {
    const { lat, lng } = offset(a.north, a.east);
    await pool.query(
      "INSERT INTO ref_next.stage_addresses (street, number, postcode, lon, lat) VALUES ($1, $2, NULL, $3, $4)",
      [a.street, a.number ?? null, lng, lat],
    );
  }
  const counts = await buildReference(pool);
  await swapReference(pool, { sources: { fixture: "1" }, bbox: null }, counts);
}

// A rectangle as WKT, corners in degrees.
export function box(xmin: number, ymin: number, xmax: number, ymax: number): string {
  return `POLYGON((${xmin} ${ymin}, ${xmax} ${ymin}, ${xmax} ${ymax}, ${xmin} ${ymax}, ${xmin} ${ymin}))`;
}
