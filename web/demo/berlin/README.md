# Berlin storefronts

A map of Berlin places linked to their accounts on the AT Protocol network, served at
<https://places.eurosky.tech/demo/berlin/>. It shows what a place looks like once it knows its
account: the account, its latest posts, and the place's record in this service.

## What a link means

A place is linked to an account when the website the place lists in Overture Maps, Foursquare or
OpenStreetMap is on the domain that is also the account's handle: `@taz.de` for a place whose
website is `www.taz.de`. Only whoever controls a domain can make it an account's handle, so the
link is verified without the business doing anything. It is not a claim: the business has not
confirmed the place yet, and the page says so.

- **Exact matches only.** The handle is the website's domain or its host without `www.`.
  Handles below a domain (`someone.example.org`) are mostly people at an organisation, not the
  organisation, and are not linked.
- **No directories.** A domain that 50 or more places list under mostly different names is a
  directory or platform (Wikipedia, LinkedIn, a city portal) and links nothing.
- **Checked by hand.** About one Berlin link in ten was wrong and is left out (listed in
  [`data/link-reviews/berlin.json`](../../../data/link-reviews/berlin.json)): a platform's domain
  given as a place's website, a parent company's account on a subsidiary's office, a local blog's
  domain on the cafés and squares it wrote about.
- **One place, one pin.** A place in two sources within 100 m of each other, linked to the same
  account, appears once.

## Files

- `index.html`: the page. It loads `data.json` beside it; the street map from
  [OpenFreeMap](https://openfreemap.org) (vector tiles from OpenStreetMap, no cookies); and
  profiles, avatars and latest posts in the browser from Eurosky's public API
  (`api.eurosky.network`). Fonts and the map library (MapLibre GL JS 4.7.1) come from this
  site, under `/fonts/` and `/vendor/`.
- `data.json`: the places (source and ID, name, category, position, district, neighbourhood)
  and the accounts (DID, handle, name, follower count) as of 24 October 2026; Berlin's
  outline and district outlines, drawn over the street map.

The snapshot is not regenerated automatically. It was made from Overture Maps (release
2026-10-21), Foursquare Open Source Places (2026-10-15), OpenStreetMap (planet of 2026-10-19) and
the account handles the Eurosky AppView had verified that day.

## Licences

`data.json` contains data from OpenStreetMap and is available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). It also contains
data from [Overture Maps](https://docs.overturemaps.org/attribution/) (CDLA Permissive 2.0, and
ODbL for the parts derived from OpenStreetMap) and from
[Foursquare Open Source Places](https://opensource.foursquare.com/os-places/) (Apache 2.0). The
page itself is under the repository's Apache 2.0 licence.

Wrong link, or a place that should not be on the map? Write to team@eurosky.tech.
