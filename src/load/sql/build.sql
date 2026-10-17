-- Turns the staging tables into the served tables. Rows are written in location order
-- (geohash), so places near each other share disk pages and a nearby lookup touches few
-- of them, even when most of the table is not cached in memory.

-- OpenStreetMap places join the others. ref_next.category_group() is created by the load
-- from the same rules DuckDB uses for the other sources (src/places/categories.ts).
INSERT INTO ref_next.stage_places (dataset, collection, id, name, category, category_group, confidence, lon, lat, wikidata)
SELECT 'openstreetmap.org',
       CASE osm_type WHEN 'N' THEN 'node' WHEN 'W' THEN 'way' ELSE 'relation' END,
       osm_id::text, name, category, ref_next.category_group(category), NULL,
       ST_X(geom), ST_Y(geom), wikidata
FROM ref_next.stage_osm_places;

CREATE TABLE ref_next.places (
  origin          text NOT NULL,      -- urn:atgeo:{dataset}:{collection}:{id}
  dataset         text NOT NULL,
  name            text NOT NULL,
  category        text,
  category_group  text NOT NULL,
  confidence      real,
  wikidata        text,               -- Wikidata ID (Q…), so far only from OpenStreetMap
  geog            geography(Point, 4326) NOT NULL
);

INSERT INTO ref_next.places
SELECT format('urn:atgeo:%s:%s:%s', dataset, collection, id),
       dataset, name, category, category_group, confidence, wikidata,
       ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
FROM ref_next.stage_places
WHERE lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90
ORDER BY ST_GeoHash(ST_SetSRID(ST_MakePoint(lon, lat), 4326), 12);

-- Source IDs are unique within a release. If a source ever breaks that, the load fails
-- here and the previous reference data stays live.
ALTER TABLE ref_next.places ADD PRIMARY KEY (origin);
CREATE INDEX places_geog_idx ON ref_next.places USING gist (geog);

-- Names besides the main one: other languages and alternative names, for search.
CREATE TABLE ref_next.place_names (
  origin  text NOT NULL REFERENCES ref_next.places,
  kind    text NOT NULL,                -- a language code (de, en, …) or alt_name, official_name, …
  name    text NOT NULL
);

INSERT INTO ref_next.place_names (origin, kind, name)
SELECT format('urn:atgeo:openstreetmap.org:%s:%s',
              CASE o.osm_type WHEN 'N' THEN 'node' WHEN 'W' THEN 'way' ELSE 'relation' END, o.osm_id),
       n.key, n.value
FROM ref_next.stage_osm_places o
CROSS JOIN LATERAL jsonb_each_text(coalesce(o.names, '{}'::jsonb)) AS n
WHERE n.value <> o.name
  AND ST_X(o.geom) BETWEEN -180 AND 180 AND ST_Y(o.geom) BETWEEN -90 AND 90;

-- Boundaries (districts up to countries). Overture's types do not line up with "city" or
-- "district" consistently (Berlin is a region, Munich a county, New York and Brooklyn are
-- both localities), so lookups order the containing areas by size instead; area_m2 is
-- what they sort by. `point` is a representative point inside the area: what an app
-- publishes when the user picks that area instead of their own position.
CREATE UNLOGGED TABLE ref_next.stage_area_shapes AS
SELECT format('urn:atgeo:overturemaps.org:division:%s', division_id) AS origin, subtype, name, country,
       ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromWKB(wkb), 4326)), 3) AS geom
FROM ref_next.stage_areas;
DELETE FROM ref_next.stage_area_shapes WHERE ST_IsEmpty(geom);

CREATE TABLE ref_next.divisions (
  origin   text PRIMARY KEY,          -- urn:atgeo:overturemaps.org:division:{id}
  subtype  text NOT NULL,             -- country, region, county, locality, macrohood, neighborhood, …
  name     text NOT NULL,
  country  text,
  area_m2  double precision NOT NULL,
  point    geography(Point, 4326) NOT NULL
);

-- A division normally has one land outline; if it ever has several, the largest wins.
INSERT INTO ref_next.divisions
SELECT DISTINCT ON (origin) origin, subtype, name, country, ST_Area(geom::geography), ST_PointOnSurface(geom)::geography
FROM ref_next.stage_area_shapes
ORDER BY origin, ST_Area(geom::geography) DESC;

-- Outlines cut into pieces of at most 256 points: testing a point against Germany's
-- ~160,000-point outline is slow, against a small piece it is cheap.
CREATE TABLE ref_next.areas (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin  text NOT NULL REFERENCES ref_next.divisions,
  geom    geometry(Polygon, 4326) NOT NULL
);

INSERT INTO ref_next.areas (origin, geom)
SELECT s.origin, d.geom
FROM ref_next.stage_area_shapes s
CROSS JOIN LATERAL ST_Subdivide(s.geom, 256) AS piece
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

-- Named streets from OpenStreetMap: the street level where there is no address data.
CREATE TABLE ref_next.streets (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  text NOT NULL,
  geog  geography(LineString, 4326) NOT NULL
);

INSERT INTO ref_next.streets (name, geog)
SELECT name, geom::geography FROM ref_next.stage_osm_streets
ORDER BY ST_GeoHash(ST_StartPoint(geom), 12);

CREATE INDEX streets_geog_idx ON ref_next.streets USING gist (geog);

DROP TABLE ref_next.stage_places, ref_next.stage_areas, ref_next.stage_area_shapes, ref_next.stage_addresses,
           ref_next.stage_osm_places, ref_next.stage_osm_streets;
DROP FUNCTION ref_next.category_group(text);
