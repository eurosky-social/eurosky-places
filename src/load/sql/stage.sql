-- A data load builds the next reference schema next to the live one (`ref`) and swaps it
-- in at the end. DuckDB fills these staging tables straight from the source Parquet files;
-- build.sql turns them into the served tables and drops them.
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
  lat             double precision NOT NULL
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
