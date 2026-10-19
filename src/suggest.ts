import type { Pool } from "./db.ts";
import { liveDataFor } from "./live.ts";
import type { CategoryGroup } from "./places/categories.ts";
import { normalizeName } from "./places/names.ts";
import { mergeCandidates, rankSuggestions, type Candidate, type Suggestion } from "./places/rank.ts";

export interface SuggestRequest {
  lat: number;
  lng: number;
  radius: number; // metres
  limit: number;
}

export interface Area {
  origin: string; // urn:atgeo:overturemaps.org:division:{id}
  name: string;
  subtype: string; // Overture's type: country, region, county, locality, macrohood, …
  country: string | null;
  // A point inside the area: what to publish when the user picks this area.
  lat: number;
  lng: number;
}

export interface Street {
  name: string;
  // The middle of the street's addresses around the user, not the user's position.
  lat: number;
  lng: number;
}

export interface SuggestResponse {
  places: Suggestion[];
  street: Street | null;
  areas: Area[];
}

// Kinds of places people check into or photograph. The nearest of these are fetched
// separately from everything else, so that in a dense street a café 300 m away is still
// a candidate even when hundreds of offices and shops are closer.
const PICKED_GROUPS: CategoryGroup[] = ["food_drink", "culture", "transit", "sights", "nature", "lodging"];
const PICKED_CANDIDATES = 400;
const OTHER_CANDIDATES = 100;

// The position is a scalar subquery in every query rather than a CTE or a constant:
// - a CTE referenced more than once is materialised and joined like a table, so Postgres
//   cannot walk the spatial index nearest-first (KNN); it reads every place within the
//   radius and sorts them instead (central Shibuya: ~20,000 rows and ~33 ms, against
//   ~1,200 index entries and ~3 ms nearest-first);
// - as a constant, Postgres estimates how many rows each spatial condition matches from
//   the column's statistics, ~1 ms of planning per condition on the worldwide data, more
//   than running the query takes outside city centres.
// A subquery's value is fixed before the scan starts, which is all nearest-first needs.
const POINT = "(SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)";
const POINT_GEOMETRY = "(SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326))";

const PLACES_SQL = `
  SELECT c.origin, c.dataset, c.name, c.category, c.category_group,
         ST_Y(c.geog::geometry) AS lat, ST_X(c.geog::geometry) AS lng, ST_Distance(c.geog, ${POINT}) AS distance
  FROM (
    (SELECT p.origin, p.dataset, p.name, p.category, p.category_group, p.geog
     FROM ref.places p
     WHERE ST_DWithin(p.geog, ${POINT}, $3) AND p.category_group = ANY($4)
     ORDER BY p.geog <-> ${POINT} LIMIT $5)
    UNION ALL
    (SELECT p.origin, p.dataset, p.name, p.category, p.category_group, p.geog
     FROM ref.places p
     WHERE ST_DWithin(p.geog, ${POINT}, $3) AND NOT (p.category_group = ANY($4))
     ORDER BY p.geog <-> ${POINT} LIMIT $6)
  ) c`;

const AREAS_SQL = `
  SELECT d.origin, d.name, d.subtype, d.country,
         ST_Y(d.point::geometry) AS lat, ST_X(d.point::geometry) AS lng
  FROM ref.divisions d
  WHERE d.origin IN (
    SELECT a.origin FROM ref.areas a
    WHERE ST_Covers(a.geom, ${POINT_GEOMETRY})
  )
  ORDER BY d.area_m2`;

// Where there is no address data nearby: the nearest named street from OpenStreetMap,
// placed at the middle of that street segment rather than at the user.
const OSM_STREET_SQL = `
  SELECT s.name, ST_Y(m.p) AS lat, ST_X(m.p) AS lng
  FROM ref.streets s
  CROSS JOIN LATERAL (SELECT ST_LineInterpolatePoint(s.geog::geometry, 0.5) AS p) m
  WHERE ST_DWithin(s.geog, ${POINT}, 50)
  ORDER BY s.geog <-> ${POINT} LIMIT 1`;

const STREET_SQL = `
  WITH nearest AS (
    SELECT a.street FROM ref.addresses a
    WHERE ST_DWithin(a.geog, ${POINT}, 100)
    ORDER BY a.geog <-> ${POINT} LIMIT 1
  )
  SELECT n.street AS name, ST_Y(m.c) AS lat, ST_X(m.c) AS lng
  FROM nearest n
  CROSS JOIN LATERAL (
    SELECT ST_Centroid(ST_Collect(a.geog::geometry)) AS c
    FROM ref.addresses a
    WHERE a.street = n.street AND ST_DWithin(a.geog, ${POINT}, 250)
  ) m`;

export const SUGGEST_SQL = { places: PLACES_SQL, areas: AREAS_SQL, street: STREET_SQL, osmStreet: OSM_STREET_SQL };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// Areas come smallest first. Overture often lists one place at several levels under the
// same name (Paris as county, municipality and city; Neukölln as borough and district);
// only the smallest of a run of same-named areas is kept.
export function collapseAreas(areas: Area[]): Area[] {
  const result: Area[] = [];
  for (const area of areas) {
    const previous = result.at(-1);
    if (previous && normalizeName(previous.name) === normalizeName(area.name)) continue;
    result.push(area);
  }
  return result;
}

// Applies live data to merged places: drops hidden ones, uses our corrected names, and
// adds up check-ins under all of a place's IDs (an app may have published any of them).
export async function withLiveData(pool: Pool, places: Suggestion[]): Promise<Suggestion[]> {
  const keys = places.flatMap((p) => [p.origin, ...p.sameAs]);
  const { counts, overrides } = await liveDataFor(pool, keys);
  const result: Suggestion[] = [];
  for (const place of places) {
    const ids = [place.origin, ...place.sameAs];
    const fixes = ids.map((id) => overrides.get(id)).filter((o) => o !== undefined);
    if (fixes.some((o) => o.hidden)) continue;
    const checkins = { total: 0, last30d: 0 };
    for (const id of ids) {
      const c = counts.get(id);
      if (c) {
        checkins.total += c.total;
        checkins.last30d += c.last30d;
      }
    }
    result.push({ ...place, name: fixes.find((o) => o.name)?.name ?? place.name, checkins });
  }
  return result;
}

export async function suggest(pool: Pool, req: SuggestRequest): Promise<SuggestResponse> {
  const point = [req.lng, req.lat];
  const [places, areas, street] = await Promise.all([
    pool.query(PLACES_SQL, [...point, req.radius, PICKED_GROUPS, PICKED_CANDIDATES, OTHER_CANDIDATES]),
    pool.query(AREAS_SQL, point),
    pool.query(STREET_SQL, point),
  ]);

  const candidates: Candidate[] = places.rows.map((r) => ({
    origin: r.origin,
    dataset: r.dataset,
    name: r.name,
    category: r.category,
    group: r.category_group,
    lat: r.lat,
    lng: r.lng,
    distance: r.distance,
  }));
  const ranked = rankSuggestions(await withLiveData(pool, mergeCandidates(candidates))).slice(0, req.limit);

  const s = street.rows[0] ?? (await pool.query(OSM_STREET_SQL, point)).rows[0];
  return {
    places: ranked.map((p) => ({ ...p, lat: round6(p.lat), lng: round6(p.lng), distance: Math.round(p.distance) })),
    street: s ? { name: s.name, lat: round6(s.lat), lng: round6(s.lng) } : null,
    areas: collapseAreas(areas.rows).map((a) => ({ ...a, lat: round6(a.lat), lng: round6(a.lng) })),
  };
}
