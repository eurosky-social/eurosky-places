-- Turns the staging tables into the served tables. Rows are written in location order
-- (geohash), so places near each other share disk pages and a nearby lookup touches few
-- of them, even when most of the table is not cached in memory.

CREATE TABLE ref_next.places (
  origin          text NOT NULL,      -- urn:atgeo:{dataset}:{collection}:{id}
  dataset         text NOT NULL,
  name            text NOT NULL,
  category        text,
  category_group  text NOT NULL,
  confidence      real,
  geog            geography(Point, 4326) NOT NULL
);

INSERT INTO ref_next.places
SELECT format('urn:atgeo:%s:%s:%s', dataset, collection, id),
       dataset, name, category, category_group, confidence,
       ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
FROM ref_next.stage_places
WHERE lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90
ORDER BY ST_GeoHash(ST_SetSRID(ST_MakePoint(lon, lat), 4326), 12);

-- Source IDs are unique within a release. If a source ever breaks that, the load fails
-- here and the previous reference data stays live.
ALTER TABLE ref_next.places ADD PRIMARY KEY (origin);
CREATE INDEX places_geog_idx ON ref_next.places USING gist (geog);

-- Boundary outlines are cut into pieces of at most 256 points: testing a point against
-- Germany's ~160,000-point outline is slow, against a small piece it is cheap.
CREATE TABLE ref_next.areas (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin   text NOT NULL,             -- urn:atgeo:overturemaps.org:division:{id}
  subtype  text NOT NULL,             -- country, region, county, locality, macrohood, neighborhood, …
  name     text NOT NULL,
  country  text,
  geom     geometry(Polygon, 4326) NOT NULL
);

INSERT INTO ref_next.areas (origin, subtype, name, country, geom)
SELECT format('urn:atgeo:overturemaps.org:division:%s', s.division_id), s.subtype, s.name, s.country, d.geom
FROM ref_next.stage_areas s
CROSS JOIN LATERAL ST_Subdivide(
  ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromWKB(s.wkb), 4326)), 3), 256
) AS piece
CROSS JOIN LATERAL ST_Dump(piece) AS d
WHERE GeometryType(d.geom) = 'POLYGON';

CREATE INDEX areas_geom_idx ON ref_next.areas USING gist (geom);

CREATE TABLE ref_next.addresses (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  street    text NOT NULL,
  number    text,
  postcode  text,
  geog      geography(Point, 4326) NOT NULL
);

INSERT INTO ref_next.addresses (street, number, postcode, geog)
SELECT street, number, postcode, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
FROM ref_next.stage_addresses
WHERE lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90
ORDER BY ST_GeoHash(ST_SetSRID(ST_MakePoint(lon, lat), 4326), 12);

CREATE INDEX addresses_geog_idx ON ref_next.addresses USING gist (geog);

DROP TABLE ref_next.stage_places, ref_next.stage_areas, ref_next.stage_addresses;
