// Type-ahead (EUR-482): what the user is typing, matched against notable places and areas
// worldwide and against everything near them.
import type { Pool } from "./db.ts";
import type { CategoryGroup } from "./places/categories.ts";
import { normalizeName } from "./places/names.ts";
import { distanceMetres, GROUP_WEIGHT, mergeCandidates, popularity, type Candidate } from "./places/rank.ts";
import { withLiveData } from "./suggest.ts";

export interface SearchRequest {
  q: string;
  lat?: number;
  lng?: number;
  limit: number;
}

// How well the typed text matched: the start of the name, the start of a later word of
// it ("tor" in "Brandenburger Tor"), another name of it (another language, alt_name), or
// only approximately (a typo).
export type Match = "start" | "word" | "other_name" | "approximate";

export const MATCH_WEIGHT: Record<Match, number> = { start: 1, word: 0.85, other_name: 0.8, approximate: 0.5 };

export interface SearchResult {
  kind: "place" | "area";
  origin: string;
  sameAs: string[];
  name: string;
  // The name that matched, when it is not `name` (e.g. "Brandenburg Gate").
  matched?: string;
  match: Match;
  category?: string | null;
  group?: CategoryGroup;
  subtype?: string;
  country?: string | null;
  lat: number;
  lng: number;
  distance?: number; // metres, when the request had a position
  checkins?: { total: number; last30d: number };
}

// Notable names: the most prominent matches worldwide, plus the nearest ones, so that a
// small district near the user is not crowded out by famous places elsewhere.
const NOTABLE_PROMINENT = 200;
const NOTABLE_NEAR = 100;
const NOTABLE_NEAR_M = 50_000;
// Everything else only counts nearby. In central Berlin 2 km is ~27,000 places. Two
// letters match plenty of them within 1 km already, and cannot use the trigram index.
const NEARBY_M = 2_000;
const NEARBY_SHORT_M = 1_000;
const NEARBY_LIMIT = 200;
// Typo matching only once there is enough text to be wrong about, and only for close
// enough names: trigram similarity 0.4 keeps "Berln" -> "Berlin" (0.44) but drops
// "Café Kreuz" -> "Kreuzberg" (0.31; Postgres's own default threshold is 0.3).
const APPROXIMATE_MIN_LENGTH = 4;
const APPROXIMATE_MIN_SIMILARITY = 0.4;
const APPROXIMATE_LIMIT = 50;
// A notable place is often in other sources too, without a Wikipedia link; fetching
// those lets the usual merge give it the same ID as in suggestions. Only for the notable
// places that can still make the list.
const TWIN_M = 75;
const TWIN_CANDIDATES = 30;
// Results this close with the same name and kind are shown once (the U-Bahn and S-Bahn
// station "Brandenburger Tor" are separate OpenStreetMap objects).
const DUPLICATE_M = 400;

// Every query normalises the typed text itself, with the same function as the stored
// names. What remains is letters, digits and single spaces, so it is safe in LIKE.
const Q = "places_norm($1)";

const NOTABLE_COLUMNS = `origin, kind, label, main, whole, prominence,
  ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng`;

const NOTABLE_SQL = `SELECT ${NOTABLE_COLUMNS} FROM (
    SELECT * FROM ref.search_names WHERE term LIKE ${Q} || '%' ORDER BY prominence DESC LIMIT ${NOTABLE_PROMINENT}
  ) t`;

const NOTABLE_NEAR_SQL = `SELECT ${NOTABLE_COLUMNS} FROM (
    SELECT * FROM ref.search_names
    WHERE term LIKE ${Q} || '%' AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, ${NOTABLE_NEAR_M})
    ORDER BY geog <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography LIMIT ${NOTABLE_NEAR}
  ) t`;

const APPROXIMATE_SQL = `SELECT ${NOTABLE_COLUMNS} FROM (
    SELECT *, similarity(term, ${Q}) AS sim FROM ref.search_names
    WHERE whole AND term % ${Q} AND similarity(term, ${Q}) >= ${APPROXIMATE_MIN_SIMILARITY}
    ORDER BY sim DESC, prominence DESC LIMIT ${APPROXIMATE_LIMIT}
  ) t`;

// Places within reach whose name has a word starting with the text. From three letters
// on, a first LIKE lets Postgres use the trigram index on name_norm (names containing
// the text anywhere) together with the spatial index. With two letters there is no
// trigram to look up: that condition would scan the whole trigram index, so it is left out
// and only the spatial index is used.
const nearbySql = (useTrigrams: boolean, radius: number) => `
  WITH here AS (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS g, ${Q} AS q)
  SELECT p.origin, p.name_norm LIKE here.q || '%' AS starts
  FROM ref.places p, here
  WHERE ${useTrigrams ? "p.name_norm LIKE '%' || here.q || '%' AND" : ""}
    ST_DWithin(p.geog, here.g, ${radius})
    AND (' ' || p.name_norm) LIKE '% ' || here.q || '%'
  ORDER BY p.geog <-> here.g LIMIT ${NEARBY_LIMIT}`;
const NEARBY_SQL = nearbySql(true, NEARBY_M);
const NEARBY_SHORT_SQL = nearbySql(false, NEARBY_SHORT_M);

const PLACES_BY_ORIGIN_SQL = `
  SELECT origin, dataset, name, category, category_group, prominence, wikidata,
         ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
  FROM ref.places WHERE origin = ANY($1)
  UNION
  SELECT t.origin, t.dataset, t.name, t.category, t.category_group, t.prominence, t.wikidata,
         ST_Y(t.geog::geometry), ST_X(t.geog::geometry)
  FROM ref.places n
  CROSS JOIN LATERAL (
    SELECT * FROM ref.places t WHERE t.dataset <> n.dataset AND ST_DWithin(t.geog, n.geog, ${TWIN_M})
    ORDER BY t.geog <-> n.geog LIMIT 10
  ) t
  WHERE n.origin = ANY($2)`;

const AREAS_BY_ORIGIN_SQL = `
  SELECT origin, name, subtype, country, prominence, wikidata,
         ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng
  FROM ref.divisions WHERE origin = ANY($1)`;

// Areas the user is inside count as distance 0, however far away their representative
// point is (a federal state's point can be a hundred kilometres off).
const CONTAINING_SQL = `
  SELECT DISTINCT origin FROM ref.areas WHERE ST_Covers(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))`;

interface NotableRow {
  origin: string;
  kind: "place" | "area";
  label: string;
  main: boolean;
  whole: boolean;
  prominence: number;
  lat: number;
  lng: number;
}

interface Found {
  match: Match;
  label?: string;
}

function matchOf(row: NotableRow, approximate: boolean): Match {
  if (approximate) return "approximate";
  if (!row.main) return "other_name";
  return row.whole ? "start" : "word";
}

// The better of two matches for the same thing.
function better(a: Found | undefined, b: Found): Found {
  return !a || MATCH_WEIGHT[b.match] > MATCH_WEIGHT[a.match] ? b : a;
}

// Close things count more, a little less with every doubling of the distance: at 1 km a
// result counts half, at 3 km a third, at 60 km about a seventh.
export function closeness(metres: number | undefined): number {
  return metres === undefined ? 1 : 1 / (1 + Math.log2(1 + metres / 1000));
}

// Higher is better: how well the text matched, the kind of place, how known it is
// (Wikipedia, several sources listing it, check-ins) and how close.
export function searchScore(r: {
  match: Match;
  group?: CategoryGroup;
  prominence: number;
  sources?: number;
  checkins?: { total: number; last30d: number };
  distance?: number;
}): number {
  const weight = r.group ? GROUP_WEIGHT[r.group] : 1;
  const agreement = 1 + 0.25 * ((r.sources ?? 1) - 1);
  const lift = r.checkins ? popularity(r.checkins) - 1 : 0;
  return MATCH_WEIGHT[r.match] * weight * agreement * (0.15 + r.prominence + 0.1 * lift) * closeness(r.distance);
}

type Scored = SearchResult & { score: number; wikidata: string | null };

// Typo matches only fill up the list: anything that matched what was actually typed comes
// first, whatever its score. Then one entry per thing (see DUPLICATE_M).
export function orderResults(results: Scored[], limit: number): Scored[] {
  const sorted = [...results].sort(
    (a, b) =>
      Number(a.match === "approximate") - Number(b.match === "approximate") ||
      b.score - a.score ||
      a.name.localeCompare(b.name),
  );
  const kept: Scored[] = [];
  for (const r of sorted) {
    const duplicate = kept.some(
      (k) =>
        k.kind === r.kind &&
        ((k.wikidata !== null && k.wikidata === r.wikidata) ||
          (normalizeName(k.name) === normalizeName(r.name) &&
            (k.group ?? k.subtype) === (r.group ?? r.subtype) &&
            distanceMetres(k, r) < DUPLICATE_M)),
    );
    if (!duplicate) kept.push(r);
    if (kept.length === limit) break;
  }
  return kept;
}

export async function search(pool: Pool, req: SearchRequest): Promise<SearchResult[]> {
  // Close enough to the database's normalisation for deciding what to run.
  const typed = normalizeName(req.q);
  if (typed.length < 2) return [];
  const here = req.lat !== undefined && req.lng !== undefined ? { lat: req.lat, lng: req.lng } : undefined;
  const at = here ? [here.lng, here.lat] : [];

  const [prominent, near, nearby, containing] = await Promise.all([
    pool.query<NotableRow>(NOTABLE_SQL, [req.q]),
    here ? pool.query<NotableRow>(NOTABLE_NEAR_SQL, [req.q, ...at]) : undefined,
    here
      ? pool.query<{ origin: string; starts: boolean }>(typed.length >= 3 ? NEARBY_SQL : NEARBY_SHORT_SQL, [req.q, ...at])
      : undefined,
    here ? pool.query<{ origin: string }>(CONTAINING_SQL, at) : undefined,
  ]);
  let notable = [...prominent.rows, ...(near?.rows ?? [])].map((row) => ({ row, approximate: false }));
  const exactHits = new Set([...notable.map((n) => n.row.origin), ...(nearby?.rows ?? []).map((r) => r.origin)]);
  if (exactHits.size < req.limit && typed.length >= APPROXIMATE_MIN_LENGTH) {
    const fuzzy = await pool.query<NotableRow>(APPROXIMATE_SQL, [req.q]);
    notable = [...notable, ...fuzzy.rows.map((row) => ({ row, approximate: true }))];
  }

  // Best match per thing.
  const matches = new Map<string, Found>();
  const kinds = new Map<string, "place" | "area">();
  for (const { row, approximate } of notable) {
    kinds.set(row.origin, row.kind);
    matches.set(row.origin, better(matches.get(row.origin), { match: matchOf(row, approximate), label: row.label }));
  }
  for (const row of nearby?.rows ?? []) {
    kinds.set(row.origin, "place");
    matches.set(row.origin, better(matches.get(row.origin), { match: row.starts ? "start" : "word" }));
  }
  const ids = (kind: "place" | "area") => [...kinds].filter(([, k]) => k === kind).map(([id]) => id);
  const distanceTo = (p: { lat: number; lng: number }) => (here ? distanceMetres(here, p) : undefined);
  const preScore = (n: (typeof notable)[number]) =>
    searchScore({ match: matchOf(n.row, n.approximate), prominence: n.row.prominence, distance: distanceTo(n.row) });
  const twinsFor = [
    ...new Set(
      notable
        .filter((n) => n.row.kind === "place")
        .sort((a, b) => preScore(b) - preScore(a))
        .map((n) => n.row.origin),
    ),
  ].slice(0, TWIN_CANDIDATES);

  const [placeRows, areaRows] = await Promise.all([
    pool.query(PLACES_BY_ORIGIN_SQL, [ids("place"), twinsFor]),
    pool.query(AREAS_BY_ORIGIN_SQL, [ids("area")]),
  ]);
  const detail = new Map<string, { prominence: number; wikidata: string | null }>(
    placeRows.rows.map((r) => [r.origin, { prominence: r.prominence, wikidata: r.wikidata }]),
  );

  // Places: the same place from several sources becomes one result, as in suggestions.
  const candidates: Candidate[] = placeRows.rows.map((r) => ({
    origin: r.origin,
    dataset: r.dataset,
    name: r.name,
    category: r.category,
    group: r.category_group,
    lat: r.lat,
    lng: r.lng,
    distance: distanceTo(r) ?? 0,
  }));
  const results: Scored[] = [];
  for (const p of await withLiveData(pool, mergeCandidates(candidates))) {
    const all = [p.origin, ...p.sameAs];
    const best = all.reduce<Found | undefined>((a, id) => (matches.has(id) ? better(a, matches.get(id)!) : a), undefined);
    // A twin fetched for merging that turned out to be another place did not match.
    if (!best) continue;
    const result: SearchResult = {
      kind: "place",
      origin: p.origin,
      sameAs: p.sameAs,
      name: p.name,
      ...(best.label && best.label !== p.name ? { matched: best.label } : {}),
      match: best.match,
      category: p.category,
      group: p.group,
      lat: p.lat,
      lng: p.lng,
      ...(here ? { distance: p.distance } : {}),
      checkins: p.checkins,
    };
    const prominence = Math.max(...all.map((id) => detail.get(id)?.prominence ?? 0));
    const wikidata = all.map((id) => detail.get(id)?.wikidata).find((w) => w) ?? null;
    results.push({ ...result, wikidata, score: searchScore({ ...result, prominence, sources: all.length }) });
  }

  const inside = new Set(containing?.rows.map((r) => r.origin) ?? []);
  for (const a of areaRows.rows) {
    const best = matches.get(a.origin)!;
    const distance = here ? (inside.has(a.origin) ? 0 : distanceTo(a)) : undefined;
    const result: SearchResult = {
      kind: "area",
      origin: a.origin,
      sameAs: [],
      name: a.name,
      ...(best.label && best.label !== a.name ? { matched: best.label } : {}),
      match: best.match,
      subtype: a.subtype,
      country: a.country,
      lat: a.lat,
      lng: a.lng,
      ...(distance !== undefined ? { distance } : {}),
    };
    results.push({ ...result, wikidata: a.wikidata, score: searchScore({ ...result, prominence: a.prominence }) });
  }

  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return orderResults(results, req.limit).map(({ score: _, wikidata: __, ...r }) => ({
    ...r,
    lat: round6(r.lat),
    lng: round6(r.lng),
    ...(r.distance !== undefined ? { distance: Math.round(r.distance) } : {}),
  }));
}
