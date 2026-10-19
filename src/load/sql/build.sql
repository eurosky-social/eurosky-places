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

CREATE INDEX ON ref_next.stage_importance (wikidata);

CREATE TABLE ref_next.places (
  origin          text NOT NULL,      -- urn:atgeo:{dataset}:{collection}:{id}
  dataset         text NOT NULL,
  name            text NOT NULL,
  name_norm       text NOT NULL,      -- places_norm(name), for search
  category        text,
  category_group  text NOT NULL,
  confidence      real,
  unconfirmed     boolean NOT NULL,   -- placed by its town alone (Meta only, no street): suggested only with a twin
  wikidata        text,               -- Wikidata ID (Q…), so far only from OpenStreetMap
  prominence      real NOT NULL,      -- Wikipedia importance 0–1 via wikidata, else 0
  cell            integer NOT NULL,   -- places_cell(lng, lat, 50): its ~2.2 km grid cell, for search
  geog            geography(Point, 4326) NOT NULL
);

INSERT INTO ref_next.places (origin, dataset, name, name_norm, category, category_group, confidence, unconfirmed,
                             wikidata, prominence, cell, geog)
SELECT format('urn:atgeo:%s:%s:%s', s.dataset, s.collection, s.id),
       s.dataset, s.name, places_norm(s.name), s.category, s.category_group, s.confidence, s.unconfirmed, s.wikidata,
       coalesce(i.importance, 0), places_cell(s.lon, s.lat, 50),
       ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)::geography
FROM ref_next.stage_places s
LEFT JOIN ref_next.stage_importance i ON i.wikidata = s.wikidata
WHERE s.lon BETWEEN -180 AND 180 AND s.lat BETWEEN -90 AND 90
ORDER BY ST_GeoHash(ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326), 12);

-- Source IDs are unique within a release. If a source ever breaks that, the load fails
-- here and the previous reference data stays live.
ALTER TABLE ref_next.places ADD PRIMARY KEY (origin);
CREATE INDEX places_geog_idx ON ref_next.places USING gist (geog);
-- Type-ahead's nearby tier: names with a word starting with the typed text, in the grid
-- cells around the user (db/migrations/004_grid.sql). With a space in front of the name,
-- "a word starts with it" is one LIKE pattern ('% text%'), and its trigrams include the
-- word-start ones ("  b", " br"), so even two letters can use the index.
CREATE INDEX places_name_idx ON ref_next.places USING gin (cell, (' ' || name_norm) gin_trgm_ops);

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
  origin      text PRIMARY KEY,       -- urn:atgeo:overturemaps.org:division:{id}
  subtype     text NOT NULL,          -- country, region, county, locality, macrohood, neighborhood, …
  name        text NOT NULL,
  country     text,
  area_m2     double precision NOT NULL,
  point       geography(Point, 4326) NOT NULL,
  wikidata    text,
  population  bigint,
  prominence  real NOT NULL           -- Wikipedia importance 0–1 via wikidata, else 0
);

-- A division normally has one land outline; if it ever has several, the largest wins.
INSERT INTO ref_next.divisions
SELECT DISTINCT ON (a.origin) a.origin, a.subtype, a.name, a.country,
       ST_Area(a.geom::geography), ST_PointOnSurface(a.geom)::geography,
       d.wikidata, d.population, coalesce(i.importance, 0)
FROM ref_next.stage_area_shapes a
LEFT JOIN ref_next.stage_divisions d ON a.origin = format('urn:atgeo:overturemaps.org:division:%s', d.division_id)
LEFT JOIN ref_next.stage_importance i ON i.wikidata = d.wikidata
ORDER BY a.origin, ST_Area(a.geom::geography) DESC;

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

-- Type-ahead's worldwide tier: every area and every place with a Wikipedia article, under
-- all its names (other languages, alternative names), one row per word the name can be
-- found by: "Brandenburger Tor" is found by "brandenburger tor" and by "tor". Everything a
-- result shows is copied in (main name, kind, position, …), so search needs no lookups in
-- the big tables: worldwide, those were random reads all over them.
CREATE TABLE ref_next.search_names (
  origin          text NOT NULL,
  kind            text NOT NULL,      -- place | area
  label           text NOT NULL,      -- the name as written
  main            boolean NOT NULL,   -- label is the thing's main name
  term            text NOT NULL,      -- places_norm(label) from one word on
  whole           boolean NOT NULL,   -- term starts at the first word
  prominence      real NOT NULL,
  cell            integer NOT NULL,   -- places_cell(lng, lat, 2): its ~55 km grid cell
  geog            geography(Point, 4326) NOT NULL,
  name            text NOT NULL,      -- the main name
  wikidata        text,
  dataset         text,               -- places only
  category        text,               -- places only
  category_group  text,               -- places only
  subtype         text,               -- areas only
  country         text                -- areas only
);

-- Stored in term order, so the rows starting with the same letters share disk pages.
INSERT INTO ref_next.search_names
WITH labels AS (
  SELECT origin, 'area' AS kind, name AS label, true AS main, prominence, point AS geog,
         name, wikidata, NULL AS dataset, NULL AS category, NULL AS category_group, subtype, country
  FROM ref_next.divisions
  UNION ALL
  SELECT dv.origin, 'area', n.value, false, dv.prominence, dv.point,
         dv.name, dv.wikidata, NULL, NULL, NULL, dv.subtype, dv.country
  FROM ref_next.divisions dv
  JOIN ref_next.stage_divisions d ON dv.origin = format('urn:atgeo:overturemaps.org:division:%s', d.division_id)
  CROSS JOIN LATERAL jsonb_each_text(coalesce(d.names::jsonb, '{}'::jsonb)) AS n
  UNION ALL
  SELECT origin, 'place', name, true, prominence, geog,
         name, wikidata, dataset, category, category_group, NULL, NULL
  FROM ref_next.places WHERE prominence > 0
  UNION ALL
  SELECT p.origin, 'place', pn.name, false, p.prominence, p.geog,
         p.name, p.wikidata, p.dataset, p.category, p.category_group, NULL, NULL
  FROM ref_next.place_names pn JOIN ref_next.places p USING (origin) WHERE p.prominence > 0
),
words AS (
  SELECT l.*, string_to_array(places_norm(l.label), ' ') AS w FROM labels l
)
SELECT origin, kind, label, main, term, whole, prominence,
       places_cell(ST_X(geog::geometry), ST_Y(geog::geometry), 2), geog,
       name, wikidata, dataset, category, category_group, subtype, country
FROM (
  SELECT DISTINCT ON (origin, term) *
  FROM (
    SELECT origin, kind, label, main, prominence, geog, name, wikidata, dataset, category, category_group, subtype, country,
           array_to_string(w[i:], ' ') AS term, i = 1 AS whole
    FROM words CROSS JOIN LATERAL generate_subscripts(w, 1) AS i
    WHERE i <= 6 AND w[i] <> ''
  ) t
  ORDER BY origin, term, main DESC, whole DESC
) best
ORDER BY term COLLATE "C";

-- Prefix match from four letters on.
CREATE INDEX search_names_term_idx ON ref_next.search_names (term text_pattern_ops);
-- Two and three letters match tens of thousands of names worldwide ("de": ~160,000):
-- these give the most prominent of them straight from the index, without sorting them all.
CREATE INDEX search_names_prefix2_idx ON ref_next.search_names (left(term, 2), prominence DESC);
CREATE INDEX search_names_prefix3_idx ON ref_next.search_names (left(term, 3), prominence DESC);
-- The nearest matches: prefix match within the grid cells around the user.
CREATE INDEX search_names_cell_idx ON ref_next.search_names (cell, term text_pattern_ops);
-- For typos: trigram similarity on whole names.
CREATE INDEX search_names_trgm_idx ON ref_next.search_names USING gin (term gin_trgm_ops) WHERE whole;

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
           ref_next.stage_osm_places, ref_next.stage_osm_streets, ref_next.stage_divisions, ref_next.stage_importance;
DROP FUNCTION ref_next.category_group(text);
