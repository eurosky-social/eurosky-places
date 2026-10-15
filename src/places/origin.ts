// Place identity follows ATGeo's scheme, so places we return can be resolved by other
// ATGeo-aware apps: urn:atgeo:{dataset}:{collection}:{id}. Dataset and collection never
// contain a colon; the id is everything after the fourth colon.
//
// "foursquare.com" is our provisional dataset name for Foursquare Open Source Places;
// ATGeo has no Foursquare dataset since garganorn dropped it, so the name still has to be
// agreed with the ATGeo working group (EUR-486).

export const DATASETS = {
  overture: "overturemaps.org",
  foursquare: "foursquare.com",
  osm: "openstreetmap.org",
} as const;

export type Dataset = (typeof DATASETS)[keyof typeof DATASETS];

export function placeOrigin(dataset: string, collection: string, id: string): string {
  if (!dataset || dataset.includes(":")) throw new Error(`invalid dataset: ${JSON.stringify(dataset)}`);
  if (!collection || collection.includes(":")) throw new Error(`invalid collection: ${JSON.stringify(collection)}`);
  if (!id) throw new Error("empty place id");
  return `urn:atgeo:${dataset}:${collection}:${id}`;
}

export interface ParsedOrigin {
  dataset: string;
  collection: string;
  id: string;
}

export function parseOrigin(origin: string): ParsedOrigin {
  const parts = origin.split(":");
  if (parts.length < 5 || parts[0] !== "urn" || parts[1] !== "atgeo") {
    throw new Error(`not an ATGeo place URN: ${origin}`);
  }
  const [, , dataset, collection, ...rest] = parts;
  return { dataset: dataset!, collection: collection!, id: rest.join(":") };
}
