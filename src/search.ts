// Type-ahead (EUR-482): what the user is typing, matched against notable places and areas
// worldwide and against everything near them.
import type { Pool } from "./db.ts";
import type { CategoryGroup } from "./places/categories.ts";
import { cityStateField } from "./places/city-states.ts";
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
  cityState?: true; // as in suggestions' areas
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
// Everything else only counts nearby. In central Berlin 2 km is ~27,000 places; two
// letters match plenty of them within 1 km already.
const NEARBY_M = 2_000;
const NEARBY_SHORT_M = 1_000;
const NEARBY_LIMIT = 200;
// Grid cells per degree (db/migrations/004_grid.sql) that the load stores with each row
// (src/load/sql/build.sql): ~2.2 km cells for places, ~55 km cells for notable names.
const PLACES_GRID = 50;
const NOTABLE_GRID = 2;
// Typo matching only once there is enough text to be wrong about, and only for close
// enough names: trigram similarity 0.4 keeps "Berln" -> "Berlin" (0.44) but drops
// "Café Kreuz" -> "Kreuzberg" (0.31). The pool sets pg_trgm.similarity_threshold to the
// same value (src/db.ts), so the index already leaves out what is further away (with
// Postgres's default of 0.3 it returned up to three times as many names to check).
export const APPROXIMATE_MIN_SIMILARITY = 0.4;
const APPROXIMATE_MIN_LENGTH = 4;
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
// A scalar subquery, not a CTE or a constant (see src/suggest.ts). The cells around the
// position are computed from $2 and $3 directly: those must be constants when the query is
// planned, so that the index lookups use them.
const POINT = "(SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography)";

const NOTABLE_COLUMNS = `origin, kind, label, main, whole, prominence, name, wikidata, dataset, category,
  category_group, subtype, country, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng`;

// The most prominent names starting with the text, worldwide. Two letters match up to
// ~160,000 names ("de"), three up to ~100,000: for those an index lists the names by their
// first two or three letters, most prominent first, so the top ones come straight from it.
// Longer text is a range of the term index: usually a few hundred names, ~60,000 for the
// commonest words ("district"), on adjoining pages since the table is in term order.
// Only one branch runs: once the text is known, its length conditions are constants.
const notableBranch = (condition: string) => `(SELECT ${NOTABLE_COLUMNS} FROM ref.search_names
    WHERE ${condition} ORDER BY prominence DESC LIMIT ${NOTABLE_PROMINENT})`;
const NOTABLE_SQL = [
  notableBranch(`length(${Q}) = 2 AND left(term, 2) = ${Q}`),
  notableBranch(`length(${Q}) = 3 AND left(term, 3) = ${Q}`),
  notableBranch(`length(${Q}) > 3 AND term LIKE ${Q} || '%'`),
].join(" UNION ALL ");

// The nearest names starting with the text: a prefix range in each grid cell around the
// user, instead of every match worldwide.
const NOTABLE_NEAR_SQL = `
  SELECT ${NOTABLE_COLUMNS} FROM ref.search_names
  WHERE cell = ANY(places_cells($2, $3, ${NOTABLE_NEAR_M}, ${NOTABLE_GRID})) AND term LIKE ${Q} || '%'
    AND ST_DWithin(geog, ${POINT}, ${NOTABLE_NEAR_M})
  ORDER BY geog <-> ${POINT} LIMIT ${NOTABLE_NEAR}`;

const APPROXIMATE_SQL = `SELECT ${NOTABLE_COLUMNS} FROM (
    SELECT *, similarity(term, ${Q}) AS sim FROM ref.search_names
    WHERE whole AND term % ${Q} AND similarity(term, ${Q}) >= ${APPROXIMATE_MIN_SIMILARITY}
    ORDER BY sim DESC, prominence DESC LIMIT ${APPROXIMATE_LIMIT}
  ) t`;

const PLACE_COLUMNS = `p.origin, p.dataset, p.name, p.category, p.category_group, p.prominence, p.wikidata,
  ST_Y(p.geog::geometry) AS lat, ST_X(p.geog::geometry) AS lng`;

// Places within reach with a word of their name starting with the text, one grid cell at a
// time: the cell and the name are the two columns of one index (places_name_idx), and
// Postgres only reads the parts of the name's trigram lists that lie in the cell. The text
// comes in through the cells' rows on purpose: as a constant, Postgres could look the name
// up once for the whole world and filter by cell afterwards, which is what took ~170 ms
// for "Shibuya Sta" on the worldwide data. Only the first letters are looked up (each
// letter is one more trigram list to read in every cell; the cell already narrows it down
// to a few names), the whole text is checked on the rows found. Distances are on the
// sphere (ST_Distance with false), which no index answers, so the planner cannot switch to
// the spatial index either (in central Shibuya that would re-check ~80,000 places).
const NEARBY_LOOKUP_LETTERS = 5;
const nearbySql = (radius: number) => `
  SELECT ${PLACE_COLUMNS}, p.name_norm LIKE c.text || '%' AS starts,
         ST_Distance(p.geog, ${POINT}, false) AS distance
  FROM (SELECT unnest(places_cells($2, $3, ${radius}, ${PLACES_GRID})) AS cell, ${Q} AS text) c
  JOIN ref.places p
    ON p.cell = c.cell AND (' ' || p.name_norm) LIKE '% ' || left(c.text, ${NEARBY_LOOKUP_LETTERS}) || '%'
  WHERE strpos(' ' || p.name_norm, ' ' || c.text) > 0 AND ST_Distance(p.geog, ${POINT}, false) <= ${radius}
  ORDER BY distance LIMIT ${NEARBY_LIMIT}`;
const NEARBY_SQL = nearbySql(NEARBY_M);
const NEARBY_SHORT_SQL = nearbySql(NEARBY_SHORT_M);

// Records from other sources next to notable places, for merging. The positions come from
// search_names, so this is one spatial lookup per place and nothing else.
const TWINS_SQL = `
  SELECT ${PLACE_COLUMNS}
  FROM unnest($1::text[], $2::float8[], $3::float8[]) AS n(dataset, lng, lat)
  CROSS JOIN LATERAL (
    SELECT * FROM ref.places t
    WHERE t.dataset <> n.dataset AND ST_DWithin(t.geog, ST_SetSRID(ST_MakePoint(n.lng, n.lat), 4326)::geography, ${TWIN_M})
    ORDER BY t.geog <-> ST_SetSRID(ST_MakePoint(n.lng, n.lat), 4326)::geography LIMIT 10
  ) p`;

// Areas the user is inside count as distance 0, however far away their representative
// point is (a federal state's point can be a hundred kilometres off).
const CONTAINING_SQL = `
  SELECT DISTINCT origin FROM ref.areas WHERE ST_Covers(geom, (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)))`;

export const SEARCH_SQL = {
  containing: CONTAINING_SQL,
  notable: NOTABLE_SQL,
  notableNear: NOTABLE_NEAR_SQL,
  approximate: APPROXIMATE_SQL,
  nearby: NEARBY_SQL,
  nearbyShort: NEARBY_SHORT_SQL,
  twins: TWINS_SQL,
};

interface PlaceRow {
  origin: string;
  dataset: string;
  name: string;
  category: string | null;
  category_group: CategoryGroup;
  prominence: number;
  wikidata: string | null;
  lat: number;
  lng: number;
}

interface NotableRow {
  origin: string;
  kind: "place" | "area";
  label: string;
  main: boolean;
  whole: boolean;
  prominence: number;
  name: string;
  wikidata: string | null;
  dataset: string | null;
  category: string | null;
  category_group: CategoryGroup | null;
  subtype: string | null;
  country: string | null;
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
      ? pool.query<PlaceRow & { starts: boolean }>(typed.length >= 3 ? NEARBY_SQL : NEARBY_SHORT_SQL, [req.q, ...at])
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
  for (const { row, approximate } of notable) {
    matches.set(row.origin, better(matches.get(row.origin), { match: matchOf(row, approximate), label: row.label }));
  }
  for (const row of nearby?.rows ?? []) {
    matches.set(row.origin, better(matches.get(row.origin), { match: row.starts ? "start" : "word" }));
  }
  const distanceTo = (p: { lat: number; lng: number }) => (here ? distanceMetres(here, p) : undefined);
  const preScore = (n: (typeof notable)[number]) =>
    searchScore({ match: matchOf(n.row, n.approximate), prominence: n.row.prominence, distance: distanceTo(n.row) });

  // Every place found, by ID: notable ones as search_names has them, nearby ones as the
  // places table does, and the other sources' records next to the best notable ones.
  const places = new Map<string, PlaceRow>();
  const areas = new Map<string, NotableRow>();
  for (const { row } of notable) {
    if (row.kind === "area") areas.set(row.origin, row);
    else places.set(row.origin, { ...row, dataset: row.dataset!, category_group: row.category_group! });
  }
  for (const row of nearby?.rows ?? []) places.set(row.origin, row);
  const twinsFor = [
    ...new Map(
      notable
        .filter((n) => n.row.kind === "place")
        .sort((a, b) => preScore(b) - preScore(a))
        .map((n) => [n.row.origin, n.row]),
    ).values(),
  ].slice(0, TWIN_CANDIDATES);
  if (twinsFor.length) {
    const twins = await pool.query<PlaceRow>(TWINS_SQL, [
      twinsFor.map((r) => r.dataset),
      twinsFor.map((r) => r.lng),
      twinsFor.map((r) => r.lat),
    ]);
    for (const row of twins.rows) if (!places.has(row.origin)) places.set(row.origin, row);
  }

  // Places: the same place from several sources becomes one result, as in suggestions.
  const candidates: Candidate[] = [...places.values()].map((r) => ({
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
    const prominence = Math.max(...all.map((id) => places.get(id)?.prominence ?? 0));
    const wikidata = all.map((id) => places.get(id)?.wikidata).find((w) => w) ?? null;
    results.push({ ...result, wikidata, score: searchScore({ ...result, prominence, sources: all.length }) });
  }

  const inside = new Set(containing?.rows.map((r) => r.origin) ?? []);
  for (const a of areas.values()) {
    const best = matches.get(a.origin)!;
    const distance = here ? (inside.has(a.origin) ? 0 : distanceTo(a)) : undefined;
    const result: SearchResult = {
      kind: "area",
      origin: a.origin,
      sameAs: [],
      name: a.name,
      ...(best.label && best.label !== a.name ? { matched: best.label } : {}),
      match: best.match,
      subtype: a.subtype!,
      ...cityStateField(a.wikidata),
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
