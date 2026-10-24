import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "./db.ts";
import type { CategoryGroup } from "./places/categories.ts";
import { isCityState } from "./places/city-states.ts";
import { charMask, normalizeName } from "./places/names.ts";
import { samePlace } from "./places/rank.ts";
import { SEARCH_SQL } from "./search.ts";

// ATGeo's lookup of one place by its origin URN, org.atgeo.getPlace (the lexicon of the ATGeo
// gazetteer, github.com/schuyler/garganorn), so ATGeo clients can use this service as a
// gazetteer. The answer is an org.atgeo.place record built from the served data and shaped
// like garganorn's: community.lexicon.location points with six decimals, the source's own
// attributes, other names as variants, containing areas broadest first. Beyond garganorn's,
// it names the same place in the other sources (sameAs), found with the rules suggestions
// merge by. Divisions carry their representative point rather than an outline's bounding box,
// and cities that Overture files as regions say so (cityState, src/places/city-states.ts).

// What garganorn splits a URN into; the id is everything after the fourth colon.
const URN = /^urn:atgeo:([^:]+):([^:]+):(.+)$/;

// The data changes with a monthly load, and a lookup by ID says nothing about the asker.
const CACHE = "public, max-age=3600";

const PLACE_SQL = `
  SELECT origin, dataset, name, category, category_group, confidence, wikidata,
         ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
  FROM ref.places WHERE origin = $1`;

const NAMES_SQL = "SELECT kind, name FROM ref.place_names WHERE origin = $1 ORDER BY kind, name";

const DIVISION_SQL = `
  SELECT origin, name, subtype, country, wikidata, population, area_m2,
         ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng
  FROM ref.divisions WHERE origin = $1`;

// Areas containing a point that are larger than $3 m², broadest first.
const WITHIN_SQL = `
  SELECT d.origin, d.name, d.subtype FROM ref.divisions d
  WHERE d.origin IN (
    SELECT a.origin FROM ref.areas a WHERE ST_Covers(a.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
  ) AND d.area_m2 > $3
  ORDER BY d.area_m2 DESC`;

interface PlaceRow {
  origin: string;
  dataset: string;
  name: string;
  category: string | null;
  category_group: CategoryGroup;
  confidence: number | null;
  wikidata: string | null;
  lat: number;
  lng: number;
}

interface DivisionRow {
  origin: string;
  name: string;
  subtype: string;
  country: string | null;
  wikidata: string | null;
  population: string | null;
  area_m2: number;
  lat: number;
  lng: number;
}

interface Relation {
  uri: string;
  name?: string;
  type?: string;
}

interface Variant {
  name: string;
  type?: string;
  language?: string;
}

export interface AtgeoPlace {
  $type: "org.atgeo.place";
  origin: string;
  name: string;
  locations: Array<{ $type: "community.lexicon.location.geo"; latitude: string; longitude: string }>;
  variants: Variant[];
  attributes: Record<string, unknown>;
  relations: { within: Relation[]; sameAs?: Relation[] };
}

const geo = (lat: number, lng: number) => ({
  $type: "community.lexicon.location.geo" as const,
  latitude: lat.toFixed(6),
  longitude: lng.toFixed(6),
});

// OpenStreetMap's other-name tags, as ATGeo's variant types.
const NAME_TYPES: Record<string, string> = {
  alt_name: "alternate",
  official_name: "official",
  short_name: "short",
  int_name: "alternate",
};

// name:<lang> keys are mostly BCP 47 tags, but OpenStreetMap also has keys like
// name:zh_pinyin; those stay variants without a language.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function variant(kind: string, name: string): Variant {
  if (NAME_TYPES[kind]) return { name, type: NAME_TYPES[kind] };
  return LANGUAGE_TAG.test(kind) ? { name, type: "alternate", language: kind } : { name, type: "alternate" };
}

// The source's own attributes, as far as the served data keeps them.
function attributes(row: PlaceRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (row.dataset === "openstreetmap.org" && row.category) {
    const [key, value] = row.category.split("=", 2);
    if (key && value) out[key] = value;
  } else if (row.dataset === "overturemaps.org" && row.category) {
    out.categories = { primary: row.category };
  } else if (row.category) {
    out.category = row.category;
  }
  if (row.confidence !== null) out.confidence = row.confidence.toFixed(3);
  if (row.wikidata) out.wikidata = row.wikidata;
  return out;
}

const relation = (r: { origin: string; name: string; subtype: string }): Relation => ({
  uri: r.origin,
  name: r.name,
  type: r.subtype,
});

async function within(pool: Pool, lat: number, lng: number, largerThan: number): Promise<Relation[]> {
  const { rows } = await pool.query(WITHIN_SQL, [lng, lat, largerThan]);
  return rows.map(relation);
}

// Records of the same place in other sources: the ones suggestions would merge it with.
async function sameAs(pool: Pool, place: PlaceRow): Promise<Relation[]> {
  const { rows } = await pool.query<PlaceRow>(SEARCH_SQL.twins, [[place.dataset], [place.lng], [place.lat]]);
  const keyed = (r: PlaceRow) => {
    const key = normalizeName(r.name);
    return { ...r, group: r.category_group, distance: 0, key, mask: charMask(key) };
  };
  const self = keyed(place);
  return rows.filter((r) => samePlace(self, keyed(r))).map((r) => ({ uri: r.origin, name: r.name }));
}

export async function atgeoPlace(pool: Pool, uri: string): Promise<AtgeoPlace | null> {
  const place = (await pool.query<PlaceRow>(PLACE_SQL, [uri])).rows[0];
  if (place) {
    const [names, areas, twins] = await Promise.all([
      pool.query<{ kind: string; name: string }>(NAMES_SQL, [uri]),
      within(pool, place.lat, place.lng, 0),
      sameAs(pool, place),
    ]);
    return {
      $type: "org.atgeo.place",
      origin: place.origin,
      name: place.name,
      locations: [geo(place.lat, place.lng)],
      variants: names.rows.map((n) => variant(n.kind, n.name)),
      attributes: attributes(place),
      relations: twins.length ? { within: areas, sameAs: twins } : { within: areas },
    };
  }
  const division = (await pool.query<DivisionRow>(DIVISION_SQL, [uri])).rows[0];
  if (division) {
    const attributes: Record<string, unknown> = { subtype: division.subtype };
    if (division.country) attributes.country = division.country;
    if (division.population !== null) attributes.population = Number(division.population);
    if (division.wikidata) attributes.wikidata = division.wikidata;
    if (isCityState(division.wikidata)) attributes.cityState = true;
    return {
      $type: "org.atgeo.place",
      origin: division.origin,
      name: division.name,
      locations: [geo(division.lat, division.lng)],
      variants: [],
      attributes,
      relations: { within: await within(pool, division.lat, division.lng, division.area_m2) },
    };
  }
  return null;
}

// XRPC errors are {error, message} with status 400, as garganorn's server answers them.
function xrpcError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

// Postgres error codes for a missing schema or table: no data load has run yet.
const NO_DATA_CODES = new Set(["3F000", "42P01"]);

export function registerAtgeoRoutes(app: FastifyInstance, pool: Pool, publicBaseUrl?: string): void {
  app.get("/xrpc/org.atgeo.getPlace", async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>, reply) => {
    // Any web app may look places up.
    reply.header("Access-Control-Allow-Origin", "*");
    const uri = request.query.uri;
    if (typeof uri !== "string" || uri.length === 0) {
      return xrpcError(reply, 400, "InvalidRequest", "uri is required");
    }
    if (!URN.test(uri) || uri.length > 512) {
      return xrpcError(reply, 400, "PlaceNotFound", `No such place: ${uri}`);
    }
    let record: AtgeoPlace | null;
    try {
      record = await atgeoPlace(pool, uri);
    } catch (error) {
      if (NO_DATA_CODES.has((error as { code?: string }).code ?? "")) {
        return xrpcError(reply, 503, "NoData", "no place data has been loaded yet");
      }
      throw error;
    }
    if (!record) return xrpcError(reply, 400, "PlaceNotFound", `No such place: ${uri}`);
    reply.header("Cache-Control", CACHE);
    const base = publicBaseUrl ?? `${request.protocol}://${request.host}`;
    return { uri: `${base}/xrpc/org.atgeo.getPlace?uri=${encodeURIComponent(uri)}`, record };
  });
}
