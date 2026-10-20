# Other projects' lexicons, for tests

Copies, so tests can validate what this service returns and proposes against the schemas
other apps read it with. Update them when the upstream changes.

| File | Source |
|---|---|
| `org.atgeo.place.json`, `org.atgeo.getPlace.json` | garganorn, `garganorn/lexicon/place.json` and `getPlace.json` at [2c7083f](https://github.com/schuyler/garganorn/tree/2c7083f/garganorn/lexicon) (2026-10-14) |
| `community.lexicon.location.bbox.json` | garganorn, `garganorn/lexicon/bbox.json` at the same commit: referenced by `org.atgeo.place`, not yet published by lexicon.community |
| `community.lexicon.location.{geo,address,hthree}.json` | lexicon.community's published records: `com.atproto.lexicon.schema` in did:plc:mtr7qrqtcyseedx3jyr5o7db (`_lexicon.location.lexicon.community`), fetched 2026-10-20 |
