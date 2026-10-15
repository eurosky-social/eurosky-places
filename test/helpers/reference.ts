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
  id: string;
  name: string;
  category?: string;
  group: CategoryGroup;
  north: number;
  east: number;
}

export interface FixtureArea {
  id: string;
  subtype: string;
  name: string;
  country?: string;
  wkt: string;
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
  for (const p of data.places ?? []) {
    const { lat, lng } = offset(p.north, p.east);
    await pool.query(
      `INSERT INTO ref_next.stage_places (dataset, collection, id, name, category, category_group, lon, lat)
       VALUES ($1, 'place', $2, $3, $4, $5, $6, $7)`,
      [p.dataset, p.id, p.name, p.category ?? null, p.group, lng, lat],
    );
  }
  for (const a of data.areas ?? []) {
    await pool.query(
      `INSERT INTO ref_next.stage_areas (division_id, subtype, name, country, wkb)
       VALUES ($1, $2, $3, $4, ST_AsBinary(ST_GeomFromText($5, 4326)))`,
      [a.id, a.subtype, a.name, a.country ?? null, a.wkt],
    );
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
