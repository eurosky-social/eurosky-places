import type { CategoryGroup } from "./categories.ts";
import { DATASETS } from "./origin.ts";
import { isLeadingWords, normalizeName, similarEnough } from "./names.ts";

// A place as it comes from one source.
export interface Candidate {
  origin: string;
  dataset: string;
  name: string;
  category: string | null;
  group: CategoryGroup;
  lat: number;
  lng: number;
  distance: number; // metres from the requested position
}

// A place as we suggest it: one entry per real place, even if several sources list it.
export interface Suggestion {
  origin: string; // the ID from the most stable source
  sameAs: string[]; // the same place in other sources
  name: string;
  category: string | null;
  group: CategoryGroup;
  lat: number;
  lng: number;
  distance: number;
  // Check-ins under any of the place's IDs.
  checkins: { total: number; last30d: number };
}

// Records closer than this, with near-identical names and compatible kinds, are taken to
// be the same place. Sources disagree on coordinates by tens of metres (McDonald's at
// Hermannplatz: Foursquare 8 m away, Overture 37 m).
const MERGE_DISTANCE_M = 75;
const MERGE_SIMILARITY = 0.9;
// "Hugendubel" and "Hugendubel Berlin Hermannplatz im Karstadt": one name is the leading
// words of the other. Riskier than near-identical names (a "Karstadt" next to a "Karstadt
// Reisebüro" is two places), so it needs closer records of the same kind.
const MERGE_LEADING_WORDS_M = 50;
const METRES_PER_DEGREE = 111_320;

// Which source's ID represents a merged place: the one whose IDs last longest
// (Foursquare ~99% over 19 months, OSM ~97% over 5 months, Overture ~38% over a year).
const DATASET_PRIORITY: Record<string, number> = {
  [DATASETS.foursquare]: 0,
  [DATASETS.osm]: 1,
  [DATASETS.overture]: 2,
};

// How much a kind of place counts in ranking: places people check into or photograph
// rank above places they rarely do. A weight of 0.5 means "as if twice as far away".
export const GROUP_WEIGHT: Record<CategoryGroup, number> = {
  food_drink: 1,
  culture: 1,
  transit: 1,
  sights: 1,
  nature: 0.9,
  lodging: 0.9,
  shopping: 0.7,
  other: 0.5,
  services: 0.35,
};

export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

function compatible(a: CategoryGroup, b: CategoryGroup): boolean {
  return a === b || a === "other" || b === "other";
}

// `key` is the normalised name (normalizeName), computed once per candidate.
export function samePlace(a: Candidate & { key: string }, b: Candidate & { key: string }): boolean {
  if (!compatible(a.group, b.group)) return false;
  // At merge distances a flat-earth approximation is off by well under a metre and costs
  // one cosine instead of the great-circle formula's five trig calls; merging a dense
  // square runs this about a million times.
  const dy = (b.lat - a.lat) * METRES_PER_DEGREE;
  const dx = (b.lng - a.lng) * METRES_PER_DEGREE * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const metres = Math.sqrt(dx * dx + dy * dy);
  if (metres > MERGE_DISTANCE_M) return false;
  if (similarEnough(a.key, b.key, MERGE_SIMILARITY)) return true;
  return metres <= MERGE_LEADING_WORDS_M && a.group === b.group && a.group !== "other" && isLeadingWords(a.key, b.key);
}

// Places are only compared with places in the same or a neighbouring grid cell, so
// merging a square of a few thousand places is not a few million comparisons. A cell is a
// little larger than the merge distance, so any two places close enough to merge are in
// neighbouring cells.
const CELL_M = MERGE_DISTANCE_M + 5;

// Groups candidates that describe the same place. A group never holds two records from
// the same source: within one source, two records are two places.
export function mergeCandidates(candidates: Candidate[]): Suggestion[] {
  type Member = Candidate & { key: string };
  const clusters: Member[][] = [];
  const cells = new Map<string, number[]>(); // cell -> indexes of clusters with a member there
  const refLat = candidates.length ? candidates.reduce((sum, c) => sum + c.lat, 0) / candidates.length : 0;
  const lngScale = (METRES_PER_DEGREE * Math.cos((refLat * Math.PI) / 180)) / CELL_M;
  const cellOf = (c: Candidate) => [Math.floor((c.lat * METRES_PER_DEGREE) / CELL_M), Math.floor(c.lng * lngScale)];

  const byDistance = [...candidates].sort((a, b) => a.distance - b.distance);
  for (const candidate of byDistance) {
    const c: Member = { ...candidate, key: normalizeName(candidate.name) };
    const [row, col] = cellOf(c);
    const nearby = new Set<number>();
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const i of cells.get(`${row! + dr},${col! + dc}`) ?? []) nearby.add(i);
      }
    }
    // The earliest-created matching cluster wins, as in a plain scan over all clusters.
    const home = [...nearby]
      .sort((a, b) => a - b)
      .find((i) => !clusters[i]!.some((m) => m.dataset === c.dataset) && clusters[i]!.some((m) => samePlace(m, c)));
    const index = home ?? clusters.push([]) - 1;
    clusters[index]!.push(c);
    const cell = `${row},${col}`;
    const inCell = cells.get(cell) ?? [];
    if (!inCell.includes(index)) cells.set(cell, [...inCell, index]);
  }
  return clusters.map((members) => {
    const ordered = [...members].sort(
      (a, b) => (DATASET_PRIORITY[a.dataset] ?? 9) - (DATASET_PRIORITY[b.dataset] ?? 9),
    );
    const main = ordered[0]!;
    return {
      origin: main.origin,
      sameAs: ordered.slice(1).map((m) => m.origin),
      name: main.name,
      category: main.category,
      group: main.group !== "other" ? main.group : (ordered.find((m) => m.group !== "other")?.group ?? "other"),
      lat: main.lat,
      lng: main.lng,
      distance: Math.min(...members.map((m) => m.distance)),
      checkins: { total: 0, last30d: 0 },
    };
  });
}

// How much check-ins lift a place: recent ones count double. 10 check-ins in the last
// month (and 10 overall) make a place rank as if it were ~2.8× closer.
export function popularity(checkins: { total: number; last30d: number }): number {
  return 1 + Math.log1p(checkins.last30d) / 2 + Math.log1p(checkins.total) / 4;
}

// How much a place counts regardless of where the user is: kinds of places people pick,
// places several sources agree on, and places people check into count more.
export function importance(s: Suggestion): number {
  const sources = 1 + s.sameAs.length;
  return GROUP_WEIGHT[s.group] * (1 + 0.25 * (sources - 1)) * popularity(s.checkins);
}

// Lower is better: distance, discounted by importance.
export function score(s: Suggestion): number {
  return (s.distance + 10) / importance(s);
}

export function rankSuggestions(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort(
    (a, b) => score(a) - score(b) || a.distance - b.distance || a.name.localeCompare(b.name),
  );
}
