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
| OpenStreetMap import (osm2pgsql) | EUR-479 | to do |
| Endpoint A: suggestions for a position | EUR-480 | done (`POST /v1/suggestions`) |
| Endpoint B: cacheable ~1 km squares | EUR-481 | to do |
| Type-ahead | EUR-482 | to do |
| Check-in counts and popularity | EUR-483 | tables exist; to do |
| Worldwide benchmark on a temporary server | EUR-484 | to do |
| Host and monthly job (eurosky-infra) | EUR-485 | to do |
| Shared formats with ATGeo | EUR-486 | to do |

## Local development

Needs Node 24 and Docker.

```sh
npm install
docker compose up -d --wait        # Postgres 17 + PostGIS 3.5 on 127.0.0.1:5433
npm run migrate
npm run load -- --bbox 13.08,52.33,13.76,52.68   # Berlin, a few minutes
npm start                          # http://127.0.0.1:3000/health
```

`npm run load` reads the newest complete Overture and Foursquare releases straight from
where they are published (S3 and Hugging Face) and keeps only rows inside `--bbox`. The
Foursquare dataset is gated: the load needs `HF_TOKEN` (or `~/.huggingface/token`) from a
Hugging Face account that accepted its terms. A worldwide load needs `--worldwide`
explicitly and belongs on the production host, not a laptop (~25 GB of downloads).

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
      "lat": 52.486723, "lng": 13.42451, "distance": 3
    },
    {
      "origin": "urn:atgeo:foursquare.com:place:4ae774f1f964a5207dab21e3",
      "sameAs": ["urn:atgeo:overturemaps.org:place:adc6176b-5d09-4dac-89a7-3649b18e525e"],
      "name": "McDonald's", "category": "Fast Food Restaurant", "group": "food_drink",
      "lat": 52.486762, "lng": 13.424558, "distance": 8
    }
  ],
  "street": { "name": "Hermannplatz", "lat": 52.486935, "lng": 13.425165 },
  "areas": [
    { "origin": "urn:atgeo:overturemaps.org:division:ae5cf3f8-c895-438d-a515-3c4d280af49f",
      "name": "Hermannplatz", "subtype": "microhood", "country": "DE", "lat": 52.487089, "lng": 13.424802 },
    { "origin": "urn:atgeo:overturemaps.org:division:a3862542-3cfa-4599-83ba-8a956ea1dc51",
      "name": "Neukölln", "subtype": "macrohood", "country": "DE", "lat": 52.477131, "lng": 13.442085 },
    { "origin": "urn:atgeo:overturemaps.org:division:59f212f3-4e73-45d4-aca6-a8c5cb0c2bfd",
      "name": "Berlin", "subtype": "region", "country": "DE", "lat": 52.506935, "lng": 13.397483 },
    { "origin": "urn:atgeo:overturemaps.org:division:567d1698-7209-4b94-b7b8-0bc71bde0104",
      "name": "Deutschland", "subtype": "country", "country": "DE", "lat": 51.164204, "lng": 10.579249 }
  ]
}
```

- `places`: one entry per real place, ranked; `origin` is the ID from the most stable
  source, `sameAs` the same place in other sources. `group` is the coarse kind (see
  `src/places/categories.ts`).
- `street`: the nearest street, with a point in its middle around the user (not the
  user's position). `null` if there is no address data within 100 m.
- `areas`: the areas containing the position, smallest first, with Overture's type and a
  point inside each. Publish that point, not the user's, when the user picks an area.
  Types are not consistent across countries (Berlin is a `region`, Munich a `county`), so
  the list is ordered by size rather than labelled street / district / city.

## Commands

| Command | What it does |
|---|---|
| `npm start` | HTTP server |
| `npm run migrate` | Applies `db/migrations/*.sql` (schemas `meta` and `live`) |
| `npm run load -- --bbox …` / `--worldwide` | Builds the next reference data and swaps it in |
| `npm run bench` | Times endpoint A on random points against the loaded data; `-- --show lat,lng` prints one answer |
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
