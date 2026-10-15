CREATE EXTENSION IF NOT EXISTS postgis;

-- One row per completed data load; the newest row describes what schema `ref` holds.
CREATE TABLE meta.releases (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  -- e.g. {"overture": "2026-09-23.1", "foursquare": "2026-09-15"}
  sources     jsonb NOT NULL,
  -- [xmin, ymin, xmax, ymax] for a partial (development) load, NULL for worldwide
  bbox        double precision[],
  counts      jsonb NOT NULL
);

-- Live data that survives the monthly reference-data swap.
CREATE SCHEMA live;

-- Keyed by the most stable ID a place has (Foursquare, then OpenStreetMap, then Overture),
-- because Overture place IDs change often between releases.
CREATE TABLE live.checkin_counts (
  place_key   text PRIMARY KEY,
  total       integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  last_30d    integer NOT NULL DEFAULT 0 CHECK (last_30d >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Our own corrections on top of the source data, e.g. hiding a private home listed as a venue.
CREATE TABLE live.place_overrides (
  place_key   text PRIMARY KEY,
  hidden      boolean NOT NULL DEFAULT false,
  name        text,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
