# Place pins: check-ins, and where photos and videos were taken, on atproto (draft)

Status: draft for discussion with the ATGeo working group. The record is not published yet;
its name, `social.eurosky.place.pin`, can still change, and we would happily see it become
`org.atgeo.checkin` or a lexicon.community record instead. Schema:
[lexicons/social/eurosky/place/pin.json](../lexicons/social/eurosky/place/pin.json).

## Summary

A small record that says "this post (or these photos or videos in it) is at this place",
written next to the post by the app. It works the same for any media and any app: it names
the media by their blobs' content IDs, not by their position in one app's record. It carries the place's identity, an ATGeo URN in `origin`, plus the
part of the place readers need to show it, put it on a map and group posts by it, so that no
reader has to ask a gazetteer for every record. The fields are a subset of `org.atgeo.place`
with the same names, and locations are `community.lexicon.location.*` objects. The author
chooses how precise it is (venue, street, district, city, region or country); the record
never carries the device's position.

This follows where the 2025 discussion ended up: external places are not turned into
atproto records, and an app stores the place's ID plus the subset it needs.

## Why now

- Apps want to ship it now: photo and video apps to say where media were taken, Bluesky
  clients to offer check-ins, and places.eurosky.tech to answer the picker behind both.
- There is no agreed check-in record. Apps that publish one today each copy a small snapshot
  of the place into their records (name, coordinates, often an address) and store the
  place's ID in their own way: `osm://node/…` strings, `fsqPlaceId`, `osmType` + `osmId`,
  `source` + `id`, collection + rkey. Nothing can group one app's check-ins with another's.
- ATGeo now names places with URNs (`urn:atgeo:{dataset}:{collection}:{id}`), which any
  record can carry, and lists the check-in record as an open question.

## Prior discussion

- [Some ideas for a checkin record](https://web.archive.org/web/2025/https://discourse.lexicon.community/t/some-ideas-for-a-checkin-record-need-input/28)
  (June 2025): copy the place into every check-in (renders without lookups, survives the
  place service, keeps the name as it was) or only reference it (no duplication).
- [Lexicon Community TSC notes](https://web.archive.org/web/2025/https://discourse.lexicon.community/t/lexicon-community-tsc-notes-referring-to-external-authoritative-data-in-atproto-apps/55)
  (August 2025): turning external places into records just to give them `at://` URIs is an
  anti-pattern; refer to them by their own IDs.
- ATGeo working group: [next steps](https://web.archive.org/web/2025/https://discourse.lexicon.community/t/atgeo-wg-next-steps-for-garganorn-and-geographic-data-in-atprotocol/56),
  [gazetteers and place references](https://web.archive.org/web/2025/https://discourse.lexicon.community/t/atgeo-wg-gazetteers-and-place-references/59)
  ("A Place reference is just a subset of a Place object"),
  [an example place object](https://web.archive.org/web/2025/https://discourse.lexicon.community/t/atgeo-wg-lets-look-at-an-example-place-object/82),
  [a location record draft](https://web.archive.org/web/2025/https://discourse.lexicon.community/t/initial-draft-proposal-for-an-atgeo-location-record-lexicon/121).
- garganorn's [place identity redesign](https://github.com/schuyler/garganorn/blob/main/docs/place-identity-redesign.md)
  (October 2026): `origin` URNs, `relation {uri, name, type}`, check-in record out of scope.

(The forum is offline; the links go to archived copies.)

## The record

| Field | Required | What |
|---|---|---|
| `subject` | no | `at://` URI of the post, or of another app's photo or video record, in the same repo. Absent for a check-in without a post. |
| `media` | no | The photos or videos the place applies to, as `{cid, mimeType}`: the blob's CID and type. Absent: the whole subject. |
| `level` | yes | `venue`, `street`, `district`, `city`, `region` or `country`: what the author chose to share. |
| `place.origin` | no | The place's ATGeo URN, from the source whose IDs last longest (Foursquare, then OpenStreetMap, then Overture). Absent where there is no ID, e.g. at street level. |
| `place.name` | yes | Display name when it was pinned. |
| `place.category` | no | Coarse kind for map icons: `transit`, `lodging`, `food_drink`, `culture`, `nature`, `sights`, `shopping`, `services`, `other`. |
| `place.locations` | yes | One to three `community.lexicon.location.*` objects; at least a `geo` point, rounded to the level. |
| `place.relations.within` | no | Containing areas, broadest first, as `{uri, name, type}`. |
| `place.relations.sameAs` | no | The place's IDs in other sources. |
| `createdAt` | yes | |

One place per record. A post whose photos or videos were taken in two places gets two pins,
each naming its media. Media are named by CID rather than by index, so the same field works
for a Bluesky post's images or video and for other apps' media records. The
CID is a `cid-link`, not a blob reference, so a pin never keeps media alive on the PDS that
the post no longer uses.

## Levels

What a pin carries depends on the level the author chose. Coordinates are decimal strings
(atproto has no floats), rounded so they say no more than the level does.

| Level | `origin` | Point | Rounded to | Extra |
|---|---|---|---|---|
| `venue` | the venue's URN; other sources' IDs in `sameAs` | the venue's own point | 5 decimals (~1 m) | `within`: all containing areas |
| `street` | none | a point on the street near the author (see Privacy) | 4 decimals (~10 m) | `address` with street, locality, country, never a house number |
| `district` | the area's URN | the area's representative point | 3 decimals (~100 m) | `within`: broader areas |
| `city` | the area's URN | the area's representative point | 2 decimals (~1 km) | `within`: broader areas |
| `region`, `country` | the area's URN | the area's representative point | 1 decimal | `within`: broader areas |

Areas come from Overture's divisions (`urn:atgeo:overturemaps.org:division:…`), whose
`type` values are Overture subtypes (`country`, `region`, `locality`, `macrohood`, …). Which
subtype counts as "district" or "city" differs by country (Berlin is a region, Munich a
county, New York and Brooklyn both localities), so the record stores the area the author
picked and its subtype, not a mapping.

Cities that Overture files as regions (Berlin, Hamburg, Vienna, Seoul, …) are the hardest
case: their boroughs are often localities, so mapping subtypes to levels offers
Friedrichshain-Kreuzberg as the city and Berlin as a region. eurosky-places marks those
cities `cityState` in its answers: an app offers such an area at the `city` level and the
city-level areas inside it (`locality`, `localadmin`, `county`) at the `district` level. That guidance only decides the `level` the author picks.
`relations.within` still carries each area's Overture subtype as `type` (`region` for
Berlin), so readers see the same data whichever app wrote the pin.

## Linking pins to posts

- The pin is a separate record (a "sidecar"), not a field in `app.bsky.feed.post` and not
  an embed: Bluesky ignores unknown embeds, and a post has one embed slot.
- The app writes the post and its pins in one `com.atproto.repo.applyWrites` call. It
  chooses the post's rkey itself, so `subject` is known before the write; the media CIDs are
  known once the blobs are uploaded, which happens first anyway. A pin for a whole
  post uses the post's rkey as its own, so readers can fetch it directly; further pins use
  new TIDs.
- `subject` is an `at://` URI rather than a strongRef, so editing the post does not break
  the link.
- When a post is deleted, the app deletes its pins; readers drop pins whose subject is gone.

## Reading pins

A reader subscribed to the collection (e.g. via Jetstream) has what it needs in the record:

- **Grouping by place:** group on `origin`, then on `sameAs` to join pins whose origins
  come from different sources.
- **ID churn:** IDs from different sources last differently. In eurosky-places' data,
  ~99% of Foursquare IDs survived 19 months and ~97% of OpenStreetMap IDs 5 months, but only
  ~38% of Overture place IDs survived a year (Overture re-matched its places in July 2026).
  Writers therefore put the longest-lived ID in `origin`, and readers can re-match a pin whose
  ID has gone by its name and point.
- **Maps:** the `geo` point and `category` are enough to cluster and draw pins.
- **Thumbnails:** the author's DID and a media CID address the blob directly (e.g. on
  Bluesky's image and video CDNs), so a map of photos needs no request for the post.
- **Areas:** `within` lets readers roll pins up by district, city or country without a lookup.
- **No index of their own:** indexes of links between records, such as Constellation, can
  answer "all pins at this place" from the `origin` field (Constellation already indexes
  `osm://` strings in other apps' records; URNs are not yet tested).

## Size

The examples below are 0.5–1.3 KB as compact JSON: roughly 300 MB for a quarter of a million
pinned posts. Copying full place records would cost several times that and bring untyped
attributes and the sources' licence terms into every record.

## Privacy

- Records are public and stay in archives after they are deleted. The level is the only
  privacy control; the device's own position, its accuracy and the author's house number are
  never written.
- A street-level point is chosen near the author (eurosky-places puts it in the middle of
  that street's addresses within ~250 m), so on a long street it says which part. Apps
  should say so in the picker; a street's own midpoint would say less.
- Media must not carry location metadata of their own, or the level means nothing: apps
  have to strip it from photos (EXIF GPS) and from videos (e.g. QuickTime location) before
  upload.
- Post time and place together say when someone was where. That is the point of a check-in,
  but apps should make the choice obvious.

## Open questions for the working group

1. **Home:** keep this under `social.eurosky.place.pin`, or move it to `org.atgeo.checkin`
   or a lexicon.community record (we would rather converge than add another).
2. **Foursquare's dataset name** in URNs (we use `foursquare.com`).
3. **`community.lexicon.location.bbox`** is referenced by `org.atgeo.place` but not
   published; pins do not need it, but a shared place subset might.
4. **OpenStreetMap in community.lexicon.location** (the open "add OSM to location lexicon"
   thread): with URNs in `origin`, a separate OSM object may not be needed.
5. **Category vocabulary:** is a shared coarse list worth agreeing, or should `category`
   stay app-defined?
6. **Standalone check-ins:** a pin without `subject` is a check-in on its own. Is that the
   check-in record, or should a check-in carry text and be its own thing?

## Examples

From [places.eurosky.tech](https://places.eurosky.tech) at Hermannplatz, Berlin; the
account is a placeholder.

A venue, for two photos in a post:

```json
{
  "$type": "social.eurosky.place.pin",
  "subject": "at://did:web:example.com/app.bsky.feed.post/3m5bq2xlnvc2s",
  "media": [
    {
      "cid": {
        "$link": "bafkreih4nhtkvxbwivqy6ky3h3fzzyxqrzu6fx2tvjalgd5ndkwtl6qopi"
      },
      "mimeType": "image/jpeg"
    },
    {
      "cid": {
        "$link": "bafkreieeszlmortvg4pmchqakxykoynno744emz2qcm5e3mesbnwhmm2sq"
      },
      "mimeType": "image/jpeg"
    }
  ],
  "level": "venue",
  "place": {
    "origin": "urn:atgeo:foursquare.com:place:4ae774f1f964a5207dab21e3",
    "name": "McDonald's",
    "category": "food_drink",
    "locations": [
      {
        "$type": "community.lexicon.location.geo",
        "latitude": "52.48676",
        "longitude": "13.42456"
      }
    ],
    "relations": {
      "within": [
        {
          "uri": "urn:atgeo:overturemaps.org:division:567d1698-7209-4b94-b7b8-0bc71bde0104",
          "name": "Deutschland",
          "type": "country"
        },
        {
          "uri": "urn:atgeo:overturemaps.org:division:59f212f3-4e73-45d4-aca6-a8c5cb0c2bfd",
          "name": "Berlin",
          "type": "region"
        },
        {
          "uri": "urn:atgeo:overturemaps.org:division:a3862542-3cfa-4599-83ba-8a956ea1dc51",
          "name": "Neukölln",
          "type": "macrohood"
        },
        {
          "uri": "urn:atgeo:overturemaps.org:division:ae5cf3f8-c895-438d-a515-3c4d280af49f",
          "name": "Hermannplatz",
          "type": "microhood"
        }
      ],
      "sameAs": [
        {
          "uri": "urn:atgeo:openstreetmap.org:node:3167656606"
        },
        {
          "uri": "urn:atgeo:overturemaps.org:place:adc6176b-5d09-4dac-89a7-3649b18e525e"
        }
      ]
    }
  },
  "createdAt": "2026-10-20T14:03:11.000Z"
}
```

A street, for a video:

```json
{
  "$type": "social.eurosky.place.pin",
  "subject": "at://did:web:example.com/app.bsky.feed.post/3m5bq2xlnvc2s",
  "media": [
    {
      "cid": {
        "$link": "bafkreicc6k3ni3cmuzfcdrjyu4sn7n6uhdpw2puybh4pgmdc7iu6jpmcce"
      },
      "mimeType": "video/mp4"
    }
  ],
  "level": "street",
  "place": {
    "name": "Hermannplatz",
    "locations": [
      {
        "$type": "community.lexicon.location.geo",
        "latitude": "52.4869",
        "longitude": "13.4252"
      },
      {
        "$type": "community.lexicon.location.address",
        "street": "Hermannplatz",
        "locality": "Berlin",
        "country": "DE"
      }
    ],
    "relations": {
      "within": [
        {
          "uri": "urn:atgeo:overturemaps.org:division:567d1698-7209-4b94-b7b8-0bc71bde0104",
          "name": "Deutschland",
          "type": "country"
        },
        {
          "uri": "urn:atgeo:overturemaps.org:division:59f212f3-4e73-45d4-aca6-a8c5cb0c2bfd",
          "name": "Berlin",
          "type": "region"
        },
        {
          "uri": "urn:atgeo:overturemaps.org:division:a3862542-3cfa-4599-83ba-8a956ea1dc51",
          "name": "Neukölln",
          "type": "macrohood"
        }
      ]
    }
  },
  "createdAt": "2026-10-20T14:03:11.000Z"
}
```

A city:

```json
{
  "$type": "social.eurosky.place.pin",
  "subject": "at://did:web:example.com/app.bsky.feed.post/3m5bq2xlnvc2s",
  "level": "city",
  "place": {
    "origin": "urn:atgeo:overturemaps.org:division:59f212f3-4e73-45d4-aca6-a8c5cb0c2bfd",
    "name": "Berlin",
    "locations": [
      {
        "$type": "community.lexicon.location.geo",
        "latitude": "52.51",
        "longitude": "13.40"
      }
    ],
    "relations": {
      "within": [
        {
          "uri": "urn:atgeo:overturemaps.org:division:567d1698-7209-4b94-b7b8-0bc71bde0104",
          "name": "Deutschland",
          "type": "country"
        }
      ]
    }
  },
  "createdAt": "2026-10-20T14:03:11.000Z"
}
```
