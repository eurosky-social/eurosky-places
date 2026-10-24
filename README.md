# eurosky-places

Place suggestions for check-ins and photo locations. An app sends the user's position and
gets back what they could attach to a post: nearby venues (Foursquare Open Source Places,
Overture Maps, OpenStreetMap) plus the street, district, city and country they are in.
The app publishes only the level the user picks.

Tracked in Linear: project **Eurosky Places** (EUR). Design and decisions:
[docs/DESIGN.md](docs/DESIGN.md).

## Status

| Part | Ticket | State |
|---|---|---|
| Repo, local Postgres/PostGIS, Berlin test data | EUR-477 | done |
| Monthly worldwide load and swap | EUR-478 | load pipeline works for an area; worldwide run, prewarm and scheduling to do |
| OpenStreetMap import (osm2pgsql) | EUR-479 | done (`--osm`) |
| Endpoint A: suggestions for a position | EUR-480 | done (`POST /v1/suggestions`) |
| Endpoint B: cacheable ~1 km squares | EUR-481 | done (`GET /v1/squares/{lat},{lng}`) |
| Type-ahead | EUR-482 | done (`POST /v1/search`) |
| Check-in counts, popularity, overrides | EUR-483 | done (`/internal/*`) |
| Worldwide benchmark on a temporary server | EUR-484 | to do |
| Host and monthly job (eurosky-infra) | EUR-485 | to do |
| Shared formats with ATGeo | EUR-486 | `org.atgeo.getPlace`; check-in format drafted ([docs/place-pin.md](docs/place-pin.md)) |

## Local development

Needs Node 24, Docker, osm2pgsql and osmium (`brew install osm2pgsql osmium-tool`,
`apt install osm2pgsql osmium-tool`).

```sh
npm install
docker compose up -d --wait        # Postgres 17 + PostGIS 3.5 on 127.0.0.1:5433
npm run migrate
curl -LO https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf   # ~100 MB
npm run load -- --bbox 13.08,52.33,13.76,52.68 --osm berlin-latest.osm.pbf  # Berlin, ~10 min
npm start                          # http://127.0.0.1:3000/health
```

`npm run load` reads the newest complete Overture and Foursquare releases straight from
where they are published (S3 and Hugging Face) and keeps only rows inside `--bbox`. Each
source goes through a local Parquet copy on its way into Postgres: writing that file uses
every thread, while writing into Postgres directly made DuckDB read one remote request at
a time (~13× slower on the production host). A worldwide load downloads the Foursquare
files whole first (~100 files, ~12 GB): read remotely, DuckDB's range requests ran into
Hugging Face's limit of 5,000 per 5 minutes. The
Foursquare dataset is gated: the load needs `HF_TOKEN` (or `~/.huggingface/token`) from a
Hugging Face account that accepted its terms. A worldwide load needs `--worldwide`
explicitly and belongs on the production host, not a laptop (~25 GB of downloads plus the
88 GB OpenStreetMap planet file, which it needs via `--osm`; set `OSM2PGSQL_CACHE_MB` to a
few GB so osm2pgsql keeps the node positions in memory; cap DuckDB with `DUCKDB_MEMORY_LIMIT` and
`DUCKDB_TEMP_DIRECTORY` there, since Postgres shares the machine). A load drops the
previous release's rollback copy before it starts building, so two copies at most are on
disk at once. After the swap it reads the tables every request needs into memory
(`pg_prewarm`, when that extension exists: a superuser has to create it), so the first
requests after a load do not wait on the disk. `--osm` is optional for `--bbox` loads. The OpenStreetMap file is filtered
with osmium first, down to the named objects with a key the import style reads (and the
nodes and members they need): that is all the style keeps, and it leaves out most of the
planet. Unfiltered, osm2pgsql needed ~100 GB of node positions on disk and read them
back at random for every way, ~12,000 ways/s on the production host (a day for the
planet's ways). Every
load also streams the Wikipedia importance file from nominatim.org (~320 MB, keeps only
the Wikidata IDs it needs); `--wikimedia <path>` uses a local copy instead.

Configuration is by environment variable; see [.env.example](.env.example).

## Endpoint A: `POST /v1/suggestions`

What someone at a position could attach to a check-in or photo. The position goes in the
body, never the URL; responses are `Cache-Control: no-store`; nothing about the request
is logged.

```sh
curl -s localhost:3000/v1/suggestions -H 'content-type: application/json' \
  -d '{"lat": 52.4867, "lng": 13.4245}'
```

| Field | | |
|---|---|---|
| `lat`, `lng` | required | WGS84 degrees |
| `radius` | 50–2000, default 500 | metres to look for places |
| `limit` | 1–100, default 30 | places to return |

Unknown fields are refused (400). With no data loaded the answer is 503 `NoData`.

Response at Hermannplatz, Berlin (real data, shortened):

```json
{
  "places": [
    {
      "origin": "urn:atgeo:foursquare.com:place:4df8e836a809df9984eb22b9",
      "sameAs": [],
      "name": "Currywurstbude", "category": "German Restaurant", "group": "food_drink",
      "lat": 52.486723, "lng": 13.42451, "distance": 3,
      "checkins": { "total": 0, "last30d": 0 }
    },
    {
      "origin": "urn:atgeo:foursquare.com:place:4ae774f1f964a5207dab21e3",
      "sameAs": ["urn:atgeo:overturemaps.org:place:adc6176b-5d09-4dac-89a7-3649b18e525e"],
      "name": "McDonald's", "category": "Fast Food Restaurant", "group": "food_drink",
      "lat": 52.486762, "lng": 13.424558, "distance": 8,
      "checkins": { "total": 0, "last30d": 0 }
    }
  ],
  "street": { "name": "Hermannplatz", "lat": 52.486935, "lng": 13.425165 },
  "areas": [
    { "origin": "urn:atgeo:overturemaps.org:division:ae5cf3f8-c895-438d-a515-3c4d280af49f",
      "name": "Hermannplatz", "subtype": "microhood", "country": "DE", "lat": 52.487089, "lng": 13.424802 },
    { "origin": "urn:atgeo:overturemaps.org:division:a3862542-3cfa-4599-83ba-8a956ea1dc51",
      "name": "Neukölln", "subtype": "macrohood", "country": "DE", "lat": 52.477131, "lng": 13.442085 },
    { "origin": "urn:atgeo:overturemaps.org:division:59f212f3-4e73-45d4-aca6-a8c5cb0c2bfd",
      "name": "Berlin", "subtype": "region", "cityState": true, "country": "DE", "lat": 52.506935, "lng": 13.397483 },
    { "origin": "urn:atgeo:overturemaps.org:division:567d1698-7209-4b94-b7b8-0bc71bde0104",
      "name": "Deutschland", "subtype": "country", "country": "DE", "lat": 51.164204, "lng": 10.579249 }
  ]
}
```

- `places`: one entry per real place, ranked; `origin` is the ID from the most stable
  source, `sameAs` the same place in other sources. `group` is the coarse kind (see
  `src/places/categories.ts`). `checkins` counts check-ins under any of the place's IDs.
- `street`: the nearest street, with a point in its middle around the user (not the
  user's position). `null` if there is no address data within 100 m.
- `areas`: the areas containing the position, smallest first, with Overture's type and a
  point inside each. Publish that point, not the user's, when the user picks an area.
  Types are not consistent across countries (Berlin is a `region`, Munich a `county`), so
  the list is ordered by size rather than labelled street / district / city.
- `cityState: true` (absent otherwise) marks an area that is one of the cities Overture
  files as regions: Berlin, Hamburg, Vienna, Prague, Moscow, Seoul, Beijing, Mexico City,
  … ([src/places/city-states.ts](src/places/city-states.ts), by Wikidata ID).

### Districts and cities

An app that maps Overture's types to levels (`neighborhood`, `microhood`, `macrohood`,
`borough` → district; `locality`, `localadmin`, `county` → city; `region`; `country`) gets
city-states wrong: Overture files the city as a region and often its boroughs as
localities. At Planufer in Berlin the areas are Kreuzberg (`macrohood`),
Friedrichshain-Kreuzberg (`locality`), Berlin (`region`) and Deutschland, so the mapping
calls Friedrichshain-Kreuzberg the city and Berlin a region; in Hamburg it calls
Hamburg-Mitte the city. Use `cityState` to fix that:

- share an area with `cityState` as the city;
- count the city-level areas before it in the list (`locality`, `localadmin`, `county`;
  they are smaller and inside it) as its districts: Friedrichshain-Kreuzberg,
  Hamburg-Mitte, Seoul's districts (`county`) and neighbourhoods (`locality`);
- some cities are filed at more than one level with the same Wikidata ID (Zagreb as a
  `locality` and a `region`), and each of those areas has the flag: they are one city, so
  offer only the largest of them, as the city.

When same-named areas collapse into one, the one kept carries the flag if any of them did
(Kinshasa's region and the locality Kinshasa become one `locality` with `cityState`). The
flag is applied when the service answers, from the division's Wikidata ID, so it needs no
data load.

## Type-ahead: `POST /v1/search`

What the user is typing, and optionally where they are, both in the body (`no-store`,
nothing logged). Send after ~150 ms without typing.

```sh
curl -s localhost:3000/v1/search -H 'content-type: application/json' \
  -d '{"q": "Brandenb", "lat": 52.4867, "lng": 13.4245}'
```

| Field | | |
|---|---|---|
| `q` | required, 1–100 characters | fewer than two letters or digits give no results |
| `lat`, `lng` | optional, together | without them only notable places and areas are searched |
| `limit` | 1–30, default 10 | |

Two tiers, ranked together:

- **notable, worldwide:** every area and every place with a Wikipedia article, under all
  its names and languages ("Brandenburg Gate", "Berlino"), matched at the start of any
  word of the name; typos are matched approximately when there are few hits.
- **nearby** (with a position): every place within 2 km (1 km for two letters) whose name
  has a word starting with the text.

Typo matches only fill up the list after real matches; the same thing found twice (same
Wikidata ID, or same name and kind within 400 m) is shown once.

`results[]`: `kind` (`place` or `area`), `origin`, `sameAs`, `name`, `matched` (the name
that matched, if another), `match` (`start`, `word`, `other_name`, `approximate`), for
places `category`, `group`, `checkins`, for areas `subtype`, `cityState` (a city filed as a
region, see [Districts and cities](#districts-and-cities)) and `country`, then `lat`, `lng`
and, with a position, `distance` (0 for areas the user is in).

## Endpoint B: `GET /v1/squares/{lat},{lng}`

Everything in one square of 0.01° × 0.01° (about 1.1 km × 0.7 km in Berlin), for apps that
do not want to send a precise position. The app names the square by its south-west corner,
rounding its position *down* to two decimals (`floor(lat × 100) / 100`), then filters and
ranks on the device. Everyone in a square asks for the same URL, so responses are
`Cache-Control: public, max-age=3600` and can sit behind a CDN.

```sh
curl -s localhost:3000/v1/squares/52.48,13.42
```

- More than two decimals is refused (`400 TooPrecise`), as are other spellings of a square
  (`52.4`, `052.48`, `-0.00`) and any query parameter other than `page`, so a careless
  client cannot put its position in the URL.
- `places`: as in endpoint A but without `distance`, most important first (kind, sources
  agreeing, check-ins), 500 per page; `next` links the following page.
- `areas` (first page only): every area overlapping the square, smallest first, with
  `cityState` as in endpoint A and `whole: true` if it covers the whole square. Otherwise
  `outline` is the part inside the square (GeoJSON, simplified to ~5 m): the app checks
  whether its own position is inside.
- Measured on the Berlin slice: a dense square (Hackescher Markt, ~2,900 places) is ~27 KB
  gzipped for its first page and ~100 ms to build; an average central-Berlin square ~40 ms.

## ATGeo: `GET /xrpc/org.atgeo.getPlace?uri=…`

The ATGeo gazetteer's lookup of one place by its origin URN
([lexicon](https://github.com/schuyler/garganorn/blob/main/garganorn/lexicon/getPlace.json)),
so ATGeo clients can use this service as a gazetteer. It answers `{uri, record}` with an
`org.atgeo.place` record built from the served data:

- places: a `community.lexicon.location.geo` point (six decimals), the source's own
  attributes as far as the data keeps them (an OpenStreetMap tag, an Overture or Foursquare
  category, Wikidata ID), other names as `variants`, the containing areas in
  `relations.within` (broadest first) and the same place in other sources in
  `relations.sameAs`, found with the rules suggestions merge by;
- areas (`urn:atgeo:overturemaps.org:division:…`): their representative point, subtype,
  country, population and Wikidata ID, `cityState: true` for a city that Overture files as
  a region (see [Districts and cities](#districts-and-cities)), and the larger areas that
  contain them. `relations.within` keeps Overture's types as they are (Berlin: `region`).

Unknown places get `400 {"error": "PlaceNotFound"}`, as from garganorn. Answers are public
for an hour (`Cache-Control`) and open to web apps (`Access-Control-Allow-Origin: *`); the
lookup says nothing about where the asker is. Tests validate every answer against ATGeo's
published lexicons. `org.atgeo.getTiles`, the other half of ATGeo's interface, is not
served.

## Internal routes: `/internal/*`

For our own components, not apps. Enabled only when `INTERNAL_TOKEN` is set; every request
needs `Authorization: Bearer $INTERNAL_TOKEN`. Keep `/internal/` off the public proxy.

| Route | Used by | |
|---|---|---|
| `POST /internal/checkins` | the check-in listener | `{"events": [{"uri": "at://…", "place": "urn:atgeo:…", "createdAt": "…"}, {"uri": "at://…", "action": "delete"}]}`, up to 1,000 per call. Idempotent by `uri`; optional `name`, `lat`, `lng` describe the place as published, for places not in our data |
| `GET /internal/overrides` | admins | all overrides |
| `PUT /internal/overrides/{urn}` | admins | `{"hidden": true}`, `{"name": "…"}`, `{"note": "…"}`; applies to the merged place that has this ID |
| `DELETE /internal/overrides/{urn}` | admins | removes an override |

## Commands

| Command | What it does |
|---|---|
| `npm start` | HTTP server |
| `npm run migrate` | Applies `db/migrations/*.sql` (schemas `meta` and `live`) |
| `npm run load -- --bbox …` / `--worldwide` | Builds the next reference data and swaps it in |
| `npm run bench` | Times endpoint A on random points against the loaded data; `-- --show lat,lng` prints one answer; `-- --search` times type-ahead with real names typed letter by letter |
| `npm test` | Tests; they recreate the `places_test` database on every run (needs `docker compose up`) |
| `npm run ci` | Type check + tests, as in CI |

## Layout

```
src/
  server.ts, main.ts       HTTP server
  migrate.ts               migration runner for db/migrations
  load/                    monthly data load: release discovery, DuckDB extraction,
    sql/stage.sql            staging tables in schema ref_next
    sql/build.sql            served tables, built from staging
  places/                  category groups, ATGeo place IDs
db/migrations/             long-lived schemas: meta (releases), live (check-in counts, overrides)
test/                      node:test suites; load.test.ts runs a full load on local fixtures
```

## Licence

The code is licensed under the [Apache License 2.0](LICENSE). The data it serves keeps its
sources' licences: Foursquare Open Source Places (Apache 2.0), Overture places
(CDLA-Permissive 2.0), Overture divisions and OpenStreetMap (ODbL); see
[docs/DESIGN.md](docs/DESIGN.md#data).
