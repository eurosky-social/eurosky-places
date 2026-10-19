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

## Interfaces

- **Endpoint A (EUR-480), `POST /v1/suggestions`:** exact position in (request body, never
  the URL), ranked places, the street and the containing areas out. Type-ahead on top
  (EUR-482). See the README for the request and response.
- **Endpoint B (EUR-481), `GET /v1/squares/{lat},{lng}`:** everything in a fixed ~1 km
  square (the position rounded down to two decimals). The same square has the same URL for everyone, so responses are cacheable on
  the phone and a CDN. For clients that do not want to send a precise position. Finer
  requests are refused, not rounded, so a client that forgets to round is caught at once.

## Data

| Source | What we take | Filters at load time |
|---|---|---|
| Foursquare Open Source Places (Apache 2.0, gated on Hugging Face) | venues | open, confirmed in the two years before the release, no `unresolved_flags`, not a non-venue (below) |
| Overture places (CDLA-Permissive 2.0) | venues | open or unknown status, confidence ≥ 0.5, confirmed by a source other than the BrightQuery company registry, not a non-venue (below) |
| Overture divisions (ODbL) | district … country outlines | land only; outlines cut into ≤ 256-point pieces |
| Overture addresses | street level | named street |
| OpenStreetMap (ODbL), EUR-479 | venues, sights, parks, named streets | named, in categories people check into or photograph (see `src/load/osm/places.lua`) |

Why all three place sources (measured 2026-09/10 in Berlin Mitte, central Madrid and
rural Tyrol, by name + distance matching):

- check-in places (food and drink, culture, hotels, stations): Overture + OSM cover ~71%
  of what the three sources know together, Foursquare + Overture ~93%;
- photo places (sights, parks): OSM alone ~63%, Overture + OSM ~85%;
- Foursquare alone is the most complete single source for check-in venues (~67%).

Overture's September 2026 release added BrightQuery company-registry records (Germany,
Italy, Denmark, US): in Berlin Mitte 13,270 of 23,003 open Overture records were
registry-only legal entities, not venues. They are filtered.

### Non-venues: the same things left out of every source (EUR-480, decided 2026-10-18)

The OpenStreetMap style never imported parking, ATMs, toilets, playgrounds and the like,
but Foursquare and Overture list them too, and the first worldwide load suggested them
("Parking Opp Laico" in central Nairobi). A load now leaves the same kinds of things out of
all three sources: `NON_VENUES` in `src/places/categories.ts`, one entry per kind with its
Foursquare labels, Overture taxonomy IDs and OpenStreetMap tags.

- **What:** parking (lots, garages, bike parking, park-and-ride); cash machines; charging
  stations; toilets, drinking fountains, public phones; vending machines and parcel or
  luggage lockers; bike and car sharing docks, taxi ranks; bus stops and platforms; roads,
  crossings, toll booths, lifts (the user's street is offered as the street level);
  playgrounds, dog parks, picnic sites; homes and residential buildings (Foursquare's
  "Home (private)" is also a privacy matter); vehicles (Foursquare's flights, trains and
  bus lines, placed wherever someone first created them); and countries, cities and
  neighbourhoods, which are offered as areas. Fuel stations and motorway rest areas stay:
  OpenStreetMap keeps fuel stations too, and rest areas have restaurants.
- **How:** a Foursquare label counts with everything below it ("Road" includes
  "Road > Intersection"); an Overture ID counts at any level of a place's taxonomy
  ("parking" includes parking_lot). A Foursquare place with several labels is kept if any
  of them is a venue, and its category is the first such label (a café also filed under
  parking stays a café). Places without a category are kept. In OpenStreetMap the style's
  deny lists and the keys it does not read do the same; a test feeds every OpenStreetMap
  tag in `NON_VENUES` through the import and checks that none comes out.
- **How many** (1% sample of the first worldwide load, 2026-10-18): ~1.5 million
  Foursquare records (4.5%; most are apartment buildings, roads and crossings, housing
  estates, bus stops, parking, towns and neighbourhoods) and ~0.6 million Overture records
  (1.1%; mostly ATMs and parking), ~2% of all places.
- **Not caught:** records whose source category is wrong. "Parking Opp Laico" is filed
  under Foursquare's "Dining and Drinking > Vineyard"; leaving out places by name
  ("Parking …") would also drop "Parking Bar & Grill" and was not done.

The same load showed category groups taken from parts of words: "garden" made ~1.4 million
Overture furniture, hardware and home stores (hardware_home_and_garden_store) "nature",
"opera" made tour operators and cooperatives "culture", and "music" bookshops and music
producers. Each put them among the kinds of places that are fetched first and ranked
highest. The rules now match those words whole, and garden shops, gardeners and forestry
before "nature". Foursquare's shrines and cemeteries are sights now, as in the other
sources; rental car desks are services, not stations.

## Suggestions: merging and ranking (EUR-480)

- **Candidates:** the 400 nearest places people check into or photograph (food and drink,
  culture, transit, sights, nature, lodging) plus the 100 nearest of everything else,
  within the radius (default 500 m). Fetching the two separately keeps a café 300 m away in
  play when a dense street has hundreds of closer offices and shops.
- **Merging:** records from different sources are one place when they are within 75 m,
  their normalised names are equal or ≥ 0.9 similar (edit distance), and their kinds are
  compatible. Also when one name is the leading words of the other ("Hugendubel" /
  "Hugendubel Berlin Hermannplatz im Karstadt"), but only within 50 m and for the same
  kind, because "Karstadt" next to "Karstadt Reisebüro" is two places. Two records from
  the same source are never merged. The merged place takes the ID of the most stable
  source (Foursquare, then OSM, then Overture); the others go into `sameAs`. Known miss:
  the same station under unrelated names ("U Hermannplatz" / "Hermannplatz Berlin
  Neukölln") stays two entries.
- **Ranking:** `(distance + 10 m) / (kind weight × (1 + 0.25 × extra sources) × popularity)`,
  lower first. Kind weights: food and drink, culture, transit, sights 1; nature, lodging
  0.9; shopping 0.7; other 0.5; services 0.35. Popularity `1 + ln(1 + check-ins in the
  last 30 days) / 2 + ln(1 + all check-ins) / 4`: 10 recent check-ins make a place rank
  as if it were ~2.8× closer. A first cut, to be tuned against real check-ins.
- **Live data** (EUR-483): hidden places (an override on any of a merged place's IDs) are
  dropped, renamed ones get our name, and check-ins under all of a place's IDs add up. One
  extra query per request fetches both.
- **Speed** (Berlin slice, local Postgres in Docker on a laptop, `npm run bench`): one
  request at a time p50 ~8–11 ms, p95 ~22–34 ms; eight at a time ~280 requests/s, p95
  ~40 ms (~360 requests/s before the live-data query).
  Name comparison is the hot spot in dense streets (hundreds of thousands of pairs), which
  is why it bails out early (`similarEnough`); a full edit distance for every pair made
  eight concurrent requests drop to ~22 requests/s.
- **Speed worldwide** (production host, worldwide data, 150 random points per city, the
  old and new code alternating on the same points, 2026-10-19): p50/p95 before → after,
  in ms: Berlin 6.2/16.6 → 5.2/8.7, Tokyo 8.1/27.8 → 6.0/7.8, New York 5.7/23.0 → 4.7/7.1,
  Paris 9.3/25.4 → 6.0/7.4, São Paulo 4.4/13.2 → 3.6/7.0, Lagos 2.6/3.7 → 1.6/2.6, central
  Shibuya 38.7/46.6 → 8.0/9.5, Times Square 43.1/86.4 → 7.0/13.7. Three causes:
  - the position was a CTE used in three places, which Postgres materialises and joins
    like a table, so it could not walk the spatial index nearest-first: it read every
    place within 500 m and sorted them (Shibuya: ~20,000 rows, ~33 ms). Now the position
    is a scalar subquery in each spatial condition;
  - not a constant either: with the position known while planning, Postgres estimates
    every spatial condition from the column statistics, ~1 ms of planning each, more than
    the whole query outside city centres;
  - merging: in a dense centre all 500 candidates lie within 100 m, so each is compared
    with nearly every group. The loop no longer sorts and allocates per candidate, and a
    32-bit character mask per name rules out most pairs before the edit distance (one edit
    changes at most two bits). Shibuya's 500 candidates: ~14 → ~4 ms on the production
    host (best of 30 runs), Times Square's ~9 → ~2 ms.
  Records equally far away are now merged in ID order, so the answer no longer depends on
  the order the database returns them in (Times Square has many records on one spot).

## Type-ahead (EUR-482)

`POST /v1/search` matches what the user types in two tiers and ranks them together.

- **Prominence** is Wikipedia importance (0–1) from the Nominatim project's file, joined
  through Wikidata IDs: OSM tags for places, Overture's division records for areas. A load
  streams the file and keeps only the IDs it has. Places without a Wikidata ID have none.
- **Notable tier:** `ref.search_names` holds every area and every place with prominence,
  under all its names (main, other languages, alternative names), one row per word the
  name can be found by ("brandenburger tor", "tor"), with prominence and position copied
  in. Prefix match on that (B-tree, `text_pattern_ops`): the 200 most prominent matches
  worldwide plus the 100 nearest within 50 km. If that gives fewer results than asked
  for, typos are tried: trigram similarity ≥ 0.4 on whole names.
- **Nearby tier:** places within 2 km (1 km for two letters) whose normalised name has a
  word starting with the text. From three letters on, a trigram index on the name
  (`places_name_trgm_idx`, ~30% of the places table) lets Postgres intersect "names
  containing the text" with "places within 2 km" instead of filtering every nearby place
  (central Berlin: ~400 rows instead of ~27,000). Two letters have no trigram to look up,
  so they use the spatial index alone, over the smaller radius.
- Names are normalised in Postgres (`places_norm`: lower case, no accents, non-letters to
  spaces) for both the stored names and the text, so they always agree.
- Notable places are merged with their twins from other sources (fetched within 75 m), so
  search returns the same IDs as suggestions; hidden places are dropped, check-ins count.
- **Score** (higher first): match (start 1, later word 0.85, other name 0.8, typo 0.5) ×
  kind weight × source agreement (1 + 0.25 per extra source) × (0.15 + prominence + 0.1 ×
  check-in lift) × closeness, where closeness is `1 / (1 + log2(1 + km))` and areas the
  user is in count as distance 0. A famous place 4.5 km away (Brandenburger Tor) beats an
  unknown café 300 m away with a similar name.
- **Typos only fill up:** approximate matches come after everything that matched what was
  typed, whatever their score. Otherwise "Tempelhofer" put the well-known district
  Tempelhof (a typo match) above the park Tempelhofer Feld (exactly what was typed).
- **One entry per thing:** results with the same Wikidata ID, or with the same name and
  kind within 400 m (the U-Bahn and S-Bahn station "Brandenburger Tor" are two OSM
  objects), are shown once.
- **Speed** (Berlin slice, laptop, `npm run bench -- --search`, real names typed letter by
  letter): one at a time p50 ~12 ms, p95 ~31 ms; eight at a time ~390 requests/s, p95
  ~49 ms. The pool runs without parallel query workers: for request-sized queries their
  start-up cost more than they saved (~30 ms of a ~40 ms query).

## Squares (EUR-481)

A square is 0.01° × 0.01°, named by its south-west corner with exactly two decimals. The
canonical spelling is enforced (it must round-trip through the formatter), so one square
has one URL and caches hit. Bounds are half-open (a place exactly on the north or east edge
belongs to the next square) and computed from integer hundredths, so there are no
floating-point gaps or overlaps between squares.

Places are merged and ranked by importance alone (kind × source agreement × popularity),
paged 500 at a time. Areas come with `whole` and, for partial ones, their outline clipped
to the square, which is what lets an app pick a district or city without sending its
position. Same-named areas collapse only among the whole ones: dropping a partial area
could drop the one the user is actually in.

Merging a dense square means thousands of places, so merging compares a place only with
places in its own and the eight neighbouring 80 m grid cells, and measures distance with a
flat-earth approximation (one cosine) instead of the great-circle formula. A test checks
that the grid gives exactly the same groups as comparing every pair. Hackescher Markt
(~3,600 records): merging ~63 ms, the whole response ~100 ms. Since 2026-10-19 (see
suggestions' speed) merging that square's ~4,400 records takes ~30 ms instead of ~85 ms,
and records are merged in ID order, so a square's answer no longer depends on the order
the database returns its places in.

## Areas: ordered by size, not mapped to levels (decided 2026-10-15)

The plan was to map Overture's area types to street / district / city / country. Checked
in twelve cities, that does not work: the city is a `region` in Berlin, Hamburg, Vienna
and Prague, a `county` in Munich, a `locality` in Madrid, Paris and Amsterdam, and in New
York both Brooklyn and New York are localities; London has no city at all around
Shoreditch. So the response lists the areas containing the user's position ordered by
size, smallest first, and drops all but the smallest of a run of same-named areas (Paris
is a county, a municipality and a city; Neukölln a borough and a district). Each area keeps
Overture's type and has a representative point inside it, computed at load time, which is
what an app publishes when the user picks that area.

The street comes from Overture addresses: the street of the nearest address within 100 m,
with the middle of that street's addresses within 250 m as its point.

## OpenStreetMap (EUR-479)

osm2pgsql reads the OSM file (an extract for development, the planet in production) with
our flex style `src/load/osm/places.lua` and writes two staging tables into `ref_next`:

- places: named objects with one of a list of tags, in order of precedence (`amenity`,
  `tourism`, `shop`, `leisure`, `historic`, stations, airports, natural features, landmarks
  such as towers and bridges, squares and islands, offices, crafts, healthcare), minus
  things nobody checks into (parking, benches, ATMs, toilets, playgrounds, …; the same
  kinds are left out of the other sources, see "Non-venues" above). Stolpersteine
  (`memorial=stolperstein`) are excluded outright: brass stones for individual victims of
  Nazism, named after the person, ~9,000 in Berlin alone; not a place to check in, and they
  buried every other sight in the first Berlin load. Ways and
  multipolygons become their centroid. The category is the tag that matched
  (`amenity=restaurant`); the group comes from the same rules as for the other sources,
  here as a Postgres function generated from `src/places/categories.ts`. The Wikidata tag
  is kept (prominence for type-ahead), and other names (`name:<lang>`, `alt_name`,
  `official_name`, …) go into `ref.place_names` for search.
- streets: named roads (`highway` residential up to trunk, pedestrian, service, …). The
  street level uses them where there is no address within 100 m: the nearest within 50 m,
  placed at the middle of that street segment.

Berlin extract (100 MB): osm2pgsql ~21 s, ~75,000 places (8,153 with a Wikidata ID),
~7,000 other names, ~96,500 street segments.

## Place identity

Places are identified ATGeo-style: `urn:atgeo:{dataset}:{collection}:{id}`, e.g.
`urn:atgeo:openstreetmap.org:way:123`. `foursquare.com` as Foursquare's dataset name is
provisional until agreed with the ATGeo working group (EUR-486).

IDs do not all survive between releases (measured): Foursquare ~99% over 19 months,
OpenStreetMap ~97% over 5 months, Overture only ~38% over a year worldwide (July 2026 was
a one-off full re-match; monthly removals have been 0.5–20%). Consequences:

- published check-ins carry a copy of the place's name and coordinates next to its ID;
- check-ins and overrides are keyed by the ID an app published, which is the merged
  place's most stable ID (Foursquare, then OSM, then Overture), and counted under all of a
  place's IDs.
- after every load, live data whose ID is no longer in the reference data moves to the
  same place's new ID: the place nearest to where it was (within 75 m) with a matching
  name (same rules as merging). The move is recorded in `live.key_moves`, so check-ins and
  overrides that still use the old ID land on the new one. Without a match the data stays
  under the old ID.

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
  one transaction. The previous one stays as `ref_prev` for rollback until the next load
  starts, which drops it first: worldwide each copy is ~200 GB, so keeping it through the
  build would mean three copies on disk at the peak instead of two.
- `live`: survives loads. `checkins` (one row per check-in record, so duplicates,
  deletions and "last 30 days" work), `place_overrides`, `place_snapshots` (name and
  position of every place with live data, for following ID changes), `key_moves`.
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
