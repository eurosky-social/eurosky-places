-- Check-ins are stored one row per record rather than as a counter: the same record can
-- be delivered twice, records get deleted, and "last 30 days" needs their dates.
CREATE TABLE live.checkins (
  uri         text PRIMARY KEY,         -- the check-in record's at:// URI
  place_key   text NOT NULL,            -- the place's ATGeo URN, as the app published it
  created_at  timestamptz NOT NULL
);
CREATE INDEX checkins_place_idx ON live.checkins (place_key, created_at);

-- Name and position of every place we hold live data for (check-ins, overrides). When a
-- monthly load retires a place's ID, these find the same place under its new ID.
CREATE TABLE live.place_snapshots (
  place_key   text PRIMARY KEY,
  name        text NOT NULL,
  geog        geography(Point, 4326) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every ID change we followed, so data and lookups under an old ID still arrive.
CREATE TABLE live.key_moves (
  old_key   text PRIMARY KEY,
  new_key   text NOT NULL,
  moved_at  timestamptz NOT NULL DEFAULT now()
);

-- Superseded by live.checkins; nothing ever wrote to it.
DROP TABLE live.checkin_counts;
