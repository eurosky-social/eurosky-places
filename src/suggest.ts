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

const PLACES_SQL = `
  WITH here AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g)
  SELECT * FROM (
    (SELECT p.origin, p.dataset, p.name, p.category, p.category_group, p.geog
     FROM ref.places p, here
     WHERE ST_DWithin(p.geog, here.g, $3) AND p.category_group = ANY($4)
     ORDER BY p.geog <-> here.g LIMIT $5)
    UNION ALL
    (SELECT p.origin, p.dataset, p.name, p.category, p.category_group, p.geog
     FROM ref.places p, here
     WHERE ST_DWithin(p.geog, here.g, $3) AND NOT (p.category_group = ANY($4))
     ORDER BY p.geog <-> here.g LIMIT $6)
  ) c
  CROSS JOIN LATERAL (
    SELECT ST_Y(c.geog::geometry) AS lat, ST_X(c.geog::geometry) AS lng,
           ST_Distance(c.geog, (SELECT g FROM here)) AS distance
  ) d`;

const AREAS_SQL = `
  SELECT d.origin, d.name, d.subtype, d.country,
         ST_Y(d.point::geometry) AS lat, ST_X(d.point::geometry) AS lng
  FROM ref.divisions d
  WHERE d.origin IN (
    SELECT a.origin FROM ref.areas a
    WHERE ST_Covers(a.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
  )
  ORDER BY d.area_m2`;

const STREET_SQL = `
  WITH here AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g),
  nearest AS (
    SELECT a.street FROM ref.addresses a, here
    WHERE ST_DWithin(a.geog, here.g, 100)
    ORDER BY a.geog <-> here.g LIMIT 1
  )
  SELECT n.street AS name, ST_Y(m.c) AS lat, ST_X(m.c) AS lng
  FROM nearest n
  CROSS JOIN LATERAL (
    SELECT ST_Centroid(ST_Collect(a.geog::geometry)) AS c
    FROM ref.addresses a, here
    WHERE a.street = n.street AND ST_DWithin(a.geog, here.g, 250)
  ) m`;

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

  const s = street.rows[0];
  return {
    places: ranked.map((p) => ({ ...p, lat: round6(p.lat), lng: round6(p.lng), distance: Math.round(p.distance) })),
    street: s ? { name: s.name, lat: round6(s.lat), lng: round6(s.lng) } : null,
    areas: collapseAreas(areas.rows).map((a) => ({ ...a, lat: round6(a.lat), lng: round6(a.lng) })),
  };
}
