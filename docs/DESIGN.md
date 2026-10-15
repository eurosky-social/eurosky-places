# Eurosky Places: design

Living document. Decisions are dated; measurements say where they come from.

## What it is for

When someone checks in or pins a photo, the app sends their position and offers a short
list to choose from:

- **places nearby**: venues, sights and stations, merged across sources;
- **areas containing the position**: street, district, borough, city, country.

The user picks one level, and only that level is published. A check-in at "Berlin"
publishes Berlin's location, never the user's point.

Events are out of scope; they are handled by a separate component.

## Interfaces (planned)

- **Endpoint A (EUR-480):** exact position in (request body, never the URL), ranked places
  and containing areas out. Type-ahead on top (EUR-482).
- **Endpoint B (EUR-481):** everything in a fixed ~1 km square (coordinates rounded to two
  decimals). The same square has the same URL for everyone, so responses are cacheable on
  the phone and a CDN. For clients that do not want to send a precise position. Finer
  requests are refused, not rounded, so a client that forgets to round is caught at once.

## Data

| Source | What we take | Filters at load time |
|---|---|---|
| Foursquare Open Source Places (Apache 2.0, gated on Hugging Face) | venues | open, confirmed in the two years before the release, no `unresolved_flags` |
| Overture places (CDLA-Permissive 2.0) | venues | open or unknown status, confidence ≥ 0.5, confirmed by a source other than the BrightQuery company registry |
| Overture divisions (ODbL) | district … country outlines | land only; outlines cut into ≤ 256-point pieces |
| Overture addresses | street level | named street |
| OpenStreetMap (ODbL), EUR-479 | venues, sights, parks, named streets | named, in categories people check into or photograph |

Why all three place sources (measured 2026-09/10 in Berlin Mitte, central Madrid and
rural Tyrol, by name + distance matching):

- check-in places (food and drink, culture, hotels, stations): Overture + OSM cover ~71%
  of what the three sources know together, Foursquare + Overture ~93%;
- photo places (sights, parks): OSM alone ~63%, Overture + OSM ~85%;
- Foursquare alone is the most complete single source for check-in venues (~67%).

Overture's September 2026 release added BrightQuery company-registry records (Germany,
Italy, Denmark, US): in Berlin Mitte 13,270 of 23,003 open Overture records were
registry-only legal entities, not venues. They are filtered.

## Place identity

Places are identified ATGeo-style: `urn:atgeo:{dataset}:{collection}:{id}`, e.g.
`urn:atgeo:openstreetmap.org:way:123`. `foursquare.com` as Foursquare's dataset name is
provisional until agreed with the ATGeo working group (EUR-486).

IDs do not all survive between releases (measured): Foursquare ~99% over 19 months,
OpenStreetMap ~97% over 5 months, Overture only ~38% over a year worldwide (July 2026 was
a one-off full re-match; monthly removals have been 0.5–20%). Consequences:

- published check-ins carry a copy of the place's name and coordinates next to its ID;
- check-in counts are keyed by the most stable ID a place has (Foursquare, then OSM, then
  Overture) and re-attached by name + distance when a key disappears (EUR-483).

## Storage: Postgres + PostGIS (decided 2026-10-15)

DuckDB querying the Parquet files directly was measured and is fast enough (~6 ms per
source per lookup on a Berlin slice). Postgres won because of the live data: check-in
counts and our own overrides are many small writes, which DuckDB's columnar storage
handles badly ("every mutation is a table rewrite", as garganorn's own docs put it). One
database for both is simpler than DuckDB plus a second store. DuckDB is still used, as the
loader: it reads the source Parquet files and writes into Postgres.

Schemas:

- `ref`: reference data (places, areas, addresses). Rebuilt from scratch by every load in
  `ref_next`, stored in location order (geohash), frozen (`VACUUM FREEZE`), then swapped in
  one transaction. The previous one stays as `ref_prev` for rollback.
- `live`: check-in counts and overrides. Survives loads.
- `meta`: migrations and one row per completed load.

## Privacy

- Positions only in request bodies; no per-request logging in the service (tested), and
  the endpoint A routes excluded from access logs and central log shipping on the host.
- No login needed for lookups, nothing stored per request.
- Endpoint B for clients that prefer not to send a precise position.

## Relation to ATGeo / garganorn

We evaluated deploying garganorn (the ATGeo gazetteer, github.com/schuyler/garganorn).
Its founding rule is that "the server must never receive information precise enough to
locate a person": no server-side search and no lookup by point. Our use case needs both,
so we built this service and adopt ATGeo's shared formats instead (place IDs, place record
shape, community location lexicons) and want to co-draft a check-in record format with the
ATGeo working group (EUR-486). Endpoint B could later also speak ATGeo's tile interface.

## Hosting (EUR-484, EUR-485)

Planned: one bare-metal host, 8 cores, 64 GB RAM, 2 × 1 TB NVMe mirrored; a dedicated
Postgres. Estimated ~60–130 GB of reference data plus indexes, ~350–450 GB peak during the
monthly refresh. NVMe is required: a cold lookup reads a few dozen pages, ~1–5 ms on NVMe
but 100–500 ms on hard disks. All of this is to be confirmed by the worldwide benchmark
before the host is ordered.
