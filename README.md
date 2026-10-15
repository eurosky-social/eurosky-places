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
| Endpoint A: suggestions for a position | EUR-480 | to do |
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

## Commands

| Command | What it does |
|---|---|
| `npm start` | HTTP server |
| `npm run migrate` | Applies `db/migrations/*.sql` (schemas `meta` and `live`) |
| `npm run load -- --bbox …` / `--worldwide` | Builds the next reference data and swaps it in |
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
