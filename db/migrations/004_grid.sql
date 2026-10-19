-- Type-ahead on the worldwide data (EUR-482): name indexes that are partitioned by place.
--
-- A trigram index over every place name in the world answers "names with a word starting
-- with 'shibuya sta'" for the whole world before the spatial index narrows it down to the
-- user's neighbourhood: ~170 ms on the worldwide data. With the grid cell of each place as
-- the first column of the same GIN index (btree_gin), Postgres intersects the cell's
-- entries with the trigrams' and only reads the parts of the trigram lists that belong to
-- the few cells around the user. The served data is stored in location order, so those
-- parts are short, contiguous runs.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- The grid: rows of 1/per_degree degrees of latitude, each cut into as many columns as keep
-- its cells about as wide as they are high, so a cell is ~111 km / per_degree across
-- everywhere (50 per degree: ~2.2 km) and a circle needs the same handful of cells at the
-- equator and in Tromsø. Few columns near the poles.
CREATE FUNCTION public.places_grid_columns(grid_row integer, per_degree integer) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT greatest(1, floor(360 * per_degree * cos(radians((grid_row + 0.5::double precision) / per_degree - 90))))::integer
$$;

-- The cell a position is in: row × (360 × per_degree) + column, unique within a grid and
-- an integer up to ~180 per degree. The load stores it, so changing it needs a new load.
CREATE FUNCTION public.places_cell(lng double precision, lat double precision, per_degree integer) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- One expression, no FROM and not STRICT (least() is not): Postgres inlines it into the
  -- load's INSERT instead of calling a function per row (~35 µs each, an hour for the
  -- world's ~120 million places). Positions are never NULL.
  SELECT least(floor((lat + 90) * per_degree), 180 * per_degree - 1)::integer * 360 * per_degree
         + floor((lng + 180) * places_grid_columns(least(floor((lat + 90) * per_degree), 180 * per_degree - 1)::integer, per_degree) / 360)::integer
           % places_grid_columns(least(floor((lat + 90) * per_degree), 180 * per_degree - 1)::integer, per_degree)
$$;

-- Every cell with a point within `radius` metres of the position. Generous rather than
-- exact: degrees are taken as 110 km (a degree of latitude is at least 110.57 km, of
-- longitude at least 111.3 km × cos(latitude) on the spheroid and the sphere), and the
-- longitude reach is the one at the circle's edge nearest the pole. Wraps around at ±180°;
-- a circle reaching a pole takes whole rows.
CREATE FUNCTION public.places_cells(lng double precision, lat double precision, radius double precision, per_degree integer)
RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT AS $$
DECLARE
  reach_lat double precision := radius / 110000.0;
  poleward double precision := least(90, abs(lat) + reach_lat);
  reach_lng double precision := 360;
  first_row integer := least(floor((greatest(-90, lat - reach_lat) + 90) * per_degree), 180 * per_degree - 1);
  last_row integer := least(floor((least(90, lat + reach_lat) + 90) * per_degree), 180 * per_degree - 1);
  columns integer;
  west integer;
  east integer;
  cells integer[] := '{}';
BEGIN
  IF cos(radians(poleward)) * 110000.0 * 180 > radius THEN
    reach_lng := radius / (110000.0 * cos(radians(poleward)));
  END IF;
  FOR grid_row IN first_row .. last_row LOOP
    columns := places_grid_columns(grid_row, per_degree);
    west := floor((lng - reach_lng + 180) * columns / 360);
    east := floor((lng + reach_lng + 180) * columns / 360);
    IF east - west + 1 >= columns THEN
      west := 0;
      east := columns - 1;
    END IF;
    FOR col IN west .. east LOOP
      cells := cells || (grid_row * 360 * per_degree + ((col % columns) + columns) % columns);
    END LOOP;
  END LOOP;
  RETURN cells;
END
$$;
