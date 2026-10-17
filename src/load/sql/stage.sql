-- A data load builds the next reference schema next to the live one (`ref`) and swaps it
-- in at the end. DuckDB fills these staging tables straight from the source Parquet files,
-- osm2pgsql the OpenStreetMap ones; build.sql turns them into the served tables and drops
-- them.
DROP SCHEMA IF EXISTS ref_next CASCADE;
CREATE SCHEMA ref_next;

CREATE UNLOGGED TABLE ref_next.stage_places (
  dataset         text NOT NULL,
  collection      text NOT NULL,
  id              text NOT NULL,
  name            text NOT NULL,
  category        text,
  category_group  text NOT NULL,
  confidence      real,
  lon             double precision NOT NULL,
  lat             double precision NOT NULL,
  wikidata        text
);

CREATE UNLOGGED TABLE ref_next.stage_areas (
  division_id  text NOT NULL,
  subtype      text NOT NULL,
  name         text NOT NULL,
  country      text,
  wkb          bytea NOT NULL
);

CREATE UNLOGGED TABLE ref_next.stage_addresses (
  street    text NOT NULL,
  number    text,
  postcode  text,
  lon       double precision NOT NULL,
  lat       double precision NOT NULL
);

-- osm2pgsql (src/load/osm/places.lua) replaces these two when a load includes
-- OpenStreetMap; otherwise they stay empty, so build.sql can always read them.
CREATE UNLOGGED TABLE ref_next.stage_osm_places (
  osm_type  char(1) NOT NULL,           -- N(ode), W(ay), R(elation)
  osm_id    bigint NOT NULL,
  name      text NOT NULL,
  category  text NOT NULL,              -- e.g. amenity=restaurant
  wikidata  text,
  names     jsonb,                      -- name:<lang>, alt_name, official_name, …
  geom      geometry(Point, 4326) NOT NULL
);

CREATE UNLOGGED TABLE ref_next.stage_osm_streets (
  osm_id  bigint NOT NULL,
  name    text NOT NULL,
  geom    geometry(LineString, 4326) NOT NULL
);
