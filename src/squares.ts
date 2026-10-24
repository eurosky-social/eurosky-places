// Endpoint B: everything in a fixed square of 0.01° × 0.01° (~1.1 km north–south, less
// east–west away from the equator), for apps that do not send a precise position. The app
// filters and ranks on the device. A square is named by its south-west corner with exactly
// two decimals, so everyone in it asks for the same URL and responses can be cached.
import type { Pool } from "./db.ts";
import { cityStateField } from "./places/city-states.ts";
import { normalizeName } from "./places/names.ts";
import { importance, mergeCandidates, withoutUnconfirmed, type Candidate, type Suggestion } from "./places/rank.ts";
import { withLiveData } from "./suggest.ts";

export interface Square {
  // Hundredths of a degree, so bounds are exact: south = row / 100, north = (row + 1) / 100.
  row: number;
  col: number;
}

export class SquareError extends Error {
  readonly code: "TooPrecise" | "InvalidSquare";

  constructor(code: "TooPrecise" | "InvalidSquare", message: string) {
    super(message);
    this.code = code;
  }
}

const CANONICAL = /^(-?\d{1,2}\.\d{2}),(-?\d{1,3}\.\d{2})$/;

// "52.48,13.42" -> the square from 52.48 to 52.49 north and 13.42 to 13.43 east. More
// decimals are refused rather than rounded, so an app that forgot to round is caught on
// its first request instead of leaking positions unnoticed. Other spellings of the same
// square ("52.4,13.42", "-0.00") are refused too, so one square has exactly one URL.
export function parseSquare(text: string): Square {
  if (/\.\d{3,}/.test(text)) {
    throw new SquareError("TooPrecise", "round down to two decimals: floor(lat × 100) / 100, floor(lng × 100) / 100");
  }
  const match = text.match(CANONICAL);
  const square = match && { row: Math.round(Number(match[1]) * 100), col: Math.round(Number(match[2]) * 100) };
  if (!square || squareName(square) !== text) {
    throw new SquareError("InvalidSquare", "expected the square's south-west corner as lat,lng with two decimals, e.g. 52.48,13.42");
  }
  if (square.row < -9000 || square.row > 8999 || square.col < -18000 || square.col > 17999) {
    throw new SquareError("InvalidSquare", "corner out of range: lat -90.00…89.99, lng -180.00…179.99");
  }
  return square;
}

export function squareName({ row, col }: Square): string {
  return `${(row / 100).toFixed(2)},${(col / 100).toFixed(2)}`;
}

export function squareOf(lat: number, lng: number): Square {
  return { row: Math.floor(lat * 100), col: Math.floor(lng * 100) };
}

export interface SquareArea {
  origin: string;
  name: string;
  subtype: string;
  cityState?: true; // as in suggestions' areas
  country: string | null;
  lat: number;
  lng: number;
  // Whether the area covers the whole square. If not, `outline` is the part of it inside
  // the square (GeoJSON, simplified to ~5 m), so the app can check its own position.
  whole: boolean;
  outline?: unknown;
}

export interface SquareResponse {
  square: { name: string; south: number; west: number; north: number; east: number };
  page: number;
  places: Array<Omit<Suggestion, "distance">>;
  next: string | null;
  areas?: SquareArea[];
}

const PLACES_SQL = `
  SELECT p.origin, p.dataset, p.name, p.category, p.category_group, p.unconfirmed,
         ST_Y(p.geog::geometry) AS lat, ST_X(p.geog::geometry) AS lng
  FROM ref.places p
  WHERE p.geog && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
    AND ST_X(p.geog::geometry) >= $1 AND ST_X(p.geog::geometry) < $3
    AND ST_Y(p.geog::geometry) >= $2 AND ST_Y(p.geog::geometry) < $4`;

const AREAS_SQL = `
  WITH sq AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS g),
  hits AS (
    SELECT a.origin, ST_CollectionExtract(ST_Union(ST_Intersection(a.geom, sq.g)), 3) AS part
    FROM ref.areas a, sq
    WHERE a.geom && sq.g AND ST_Intersects(a.geom, sq.g)
    GROUP BY a.origin
  )
  SELECT d.origin, d.name, d.subtype, d.country, d.wikidata,
         ST_Y(d.point::geometry) AS lat, ST_X(d.point::geometry) AS lng,
         ST_Area(h.part) >= ST_Area(sq.g) * 0.9999 AS whole,
         ST_AsGeoJSON(ST_SimplifyPreserveTopology(h.part, 0.00005), 6) AS outline
  FROM hits h JOIN ref.divisions d USING (origin), sq
  WHERE ST_Area(h.part) > 0
  ORDER BY d.area_m2`;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// Same-named areas that each cover the whole square are one choice for the user (Paris
// as county, municipality and city); keep the smallest, a city-state if one of them is (see
// collapseAreas in src/suggest.ts). Partial areas are always kept: the app still has to
// check whether it is inside them.
export function collapseWholeAreas(areas: SquareArea[]): SquareArea[] {
  const result: SquareArea[] = [];
  let lastWhole = -1;
  for (const area of areas) {
    if (area.whole) {
      const previous = result[lastWhole];
      if (previous && normalizeName(previous.name) === normalizeName(area.name)) {
        if (area.cityState) result[lastWhole] = { ...previous, cityState: true };
        continue;
      }
      lastWhole = result.length;
    }
    result.push(area);
  }
  return result;
}

export async function squareContents(pool: Pool, square: Square, page: number, pageSize: number): Promise<SquareResponse> {
  const bounds = [square.col / 100, square.row / 100, (square.col + 1) / 100, (square.row + 1) / 100];
  const [places, areas] = await Promise.all([
    pool.query(PLACES_SQL, bounds),
    page === 1 ? pool.query(AREAS_SQL, bounds) : Promise.resolve(undefined),
  ]);

  const candidates: Candidate[] = places.rows.map((r) => ({
    origin: r.origin,
    dataset: r.dataset,
    name: r.name,
    category: r.category,
    group: r.category_group,
    lat: r.lat,
    lng: r.lng,
    distance: 0,
    unconfirmed: r.unconfirmed,
  }));
  // Squares are suggestions too: records placed by their town alone only with a twin.
  const ranked = (await withLiveData(pool, withoutUnconfirmed(mergeCandidates(candidates), candidates))).sort(
    (a, b) => importance(b) - importance(a) || a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin),
  );
  const slice = ranked.slice((page - 1) * pageSize, page * pageSize);
  const name = squareName(square);

  const response: SquareResponse = {
    square: { name, south: bounds[1]!, west: bounds[0]!, north: bounds[3]!, east: bounds[2]! },
    page,
    places: slice.map(({ distance: _, ...p }) => ({ ...p, lat: round6(p.lat), lng: round6(p.lng) })),
    next: ranked.length > page * pageSize ? `/v1/squares/${name}?page=${page + 1}` : null,
  };
  if (areas) {
    response.areas = collapseWholeAreas(
      areas.rows.map((a) => ({
        origin: a.origin,
        name: a.name,
        subtype: a.subtype,
        ...cityStateField(a.wikidata),
        country: a.country,
        lat: round6(a.lat),
        lng: round6(a.lng),
        whole: a.whole,
        ...(a.whole ? {} : { outline: JSON.parse(a.outline) }),
      })),
    );
  }
  return response;
}
