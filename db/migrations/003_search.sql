-- Type-ahead search (EUR-482).
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- How names are compared in search: lower case, no accents, anything that is not a
-- letter or digit becomes a single space. "Café  Kreuzberg!" -> "cafe kreuzberg".
-- Stored names and the typed text both go through this, so they always agree.
-- (unaccent() is only STABLE; with its dictionary named explicitly it is safe to declare
-- the wrapper IMMUTABLE.)
CREATE FUNCTION public.places_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT btrim(regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, t)), '[^[:alnum:]]+', ' ', 'g'))
$$;
