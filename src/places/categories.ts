// Every place gets one coarse group, derived from its source category, so ranking can
// prefer places people check into or photograph (a café, a monument) over places they
// rarely do (a dentist, a law firm).
//
// The rules run in three engines: DuckDB during the data load (categoryGroupMacroSql),
// Postgres for OpenStreetMap (categoryGroupPostgresSql) and TypeScript (categoryGroup).
// Patterns therefore stick to syntax all of them understand: DuckDB uses RE2, which has
// no lookarounds. First matching rule wins.

export const CATEGORY_GROUPS = [
  "transit",
  "lodging",
  "food_drink",
  "culture",
  "nature",
  "sights",
  "shopping",
  "services",
  "other",
] as const;

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const CATEGORY_RULES: ReadonlyArray<readonly [CategoryGroup, string]> = [
  // Must come before "nature", whose pattern matches "park", and before "transit", which
  // would take Foursquare's "Transport Hub > Rental Car Location" for a station.
  ["services", "parking|car_park|car park|rental car"],
  ["transit", "(rail|train|subway|metro|tram|bus)[ _]?station|railway=(station|halt)|public_transport=station|aeroway=terminal|airport|aerodrome|ferry|transport hub|light rail"],
  ["lodging", "hotel|hostel|guest_?house|motel|lodging|accommodation|bed and breakfast|bed_and_breakfast|resort|holiday_rental|vacation_rental|campground|camping"],
  ["food_drink", "restaurant|dining|cafe|café|coffee|\\bbars?\\b|_bar\\b|\\bpub\\b|biergarten|beer_garden|brewery|winery|cocktail|fast_food|ice_cream|dessert|tapas|bistro|food_court|nightlife|night_?club|eat_and_drink|food_and_drink|bakery|eatery|snack|burger|pizza|kebab|doner|deli\\b"],
  // Words, not parts of words: "opera" is also in tour_operator and cooperative, "theater"
  // in home_theater_systems_stores, "music" in books_music_and_video_store and
  // music_production, "movie" in movie_television_studio.
  ["culture", "museum|theat(er|re)(\\b|_venue)|cinema|movie[ _]theat|gallery|arts_centre|arts and entertainment|arts_and_entertainment|music[ _](venue|school|festival)|concert|\\bopera\\b|\\bzoo\\b|aquarium|stadium|arena|events?_venue|theme_park|amusement|performing|festival|planetarium"],
  // Shops and trades named after gardens, forests and natural gas: before "nature"; tour
  // operators (a "historical_tour") before "sights".
  ["shopping", "home_and_garden|garden[ _]cent|gardening_store|^shop=garden"],
  ["services", "gardener|landscap|forestry|natural[ _]gas|naturalization|tour_operator"],
  ["nature", "\\bpark\\b|_park\\b|garden|nature|natural|beach|lake|forest|mountain|peak|river|waterfall|trail\\b|hiking"],
  ["sights", "landmark|monument|memorial|historic|attraction|viewpoint|scenic|sculpture|statue|castle|palace|church|cathedral|mosque|synagogue|temple|shrine|place_of_worship|religious|\\bcemetery\\b|fountain|bridge|plaza|square|tower|lighthouse|public art|public_art|artwork"],
  ["shopping", "retail|shop|store|shopping|market|boutique|\\bmall\\b"],
  ["services", "office|professional|service|business|government|health|medical|doctor|dentist|clinic|pharmacy|school|education|\\bbank|\\batm\\b|lawyer|attorney|agency|company|insurance|real_estate|repair"],
];

const compiled = CATEGORY_RULES.map(([group, pattern]) => [group, new RegExp(pattern)] as const);

// `description` is whatever the source says about the place's kind, e.g. Overture's
// "coffee_shop food_and_drink > cafe" or Foursquare's "Dining and Drinking > Coffee Shop".
export function categoryGroup(description: string): CategoryGroup {
  const text = description.toLowerCase();
  for (const [group, re] of compiled) {
    if (re.test(text)) return group;
  }
  return "other";
}

// The same rules as a Postgres function `<schema>.category_group(description)`, for
// OpenStreetMap places, which osm2pgsql writes straight into Postgres. Postgres regular
// expressions spell a word boundary `\y` (`\b` means backspace there).
export function categoryGroupPostgresSql(schema: string): string {
  const arms = CATEGORY_RULES.map(
    ([group, pattern]) => `WHEN d ~ '${pattern.replaceAll("\\b", "\\y").replaceAll("'", "''")}' THEN '${group}'`,
  ).join("\n      ");
  return `CREATE OR REPLACE FUNCTION ${schema}.category_group(description text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      ${arms}
      ELSE 'other'
    END FROM (SELECT lower(coalesce(description, '')) AS d) AS x
  $$`;
}

// The same rules as a DuckDB macro, `category_group(description)`.
export function categoryGroupMacroSql(): string {
  const arms = CATEGORY_RULES.map(
    ([group, pattern]) =>
      `WHEN regexp_matches(lower(coalesce(description, '')), '${pattern.replaceAll("'", "''")}') THEN '${group}'`,
  ).join("\n    ");
  return `CREATE OR REPLACE MACRO category_group(description) AS (\n  CASE\n    ${arms}\n    ELSE 'other'\n  END\n)`;
}

// Things the sources list that nobody checks into or photographs: where to leave a car or
// get cash, stops and roads, homes, vehicles, and towns or neighbourhoods (which are
// offered as areas, not places). A load leaves them out entirely, so they are neither
// suggested nor found by search. The OpenStreetMap import never takes them in the first
// place (src/load/osm/places.lua: the deny lists, and the keys and values it does not
// read); these lists apply the same intent to the other two sources' taxonomies:
//
// - foursquare: category labels, with everything below them ("Travel and Transportation
//   > Road" includes "> Road > Intersection");
// - overture: taxonomy IDs, matched against every level of a place's taxonomy hierarchy
//   and its basic category ("parking" includes parking_lot and bike_parking).
//
// `osm` names the OpenStreetMap tags of the same things; a test checks that the import
// skips them.
export interface NonVenue {
  what: string;
  osm: readonly string[];
  foursquare: readonly string[];
  overture: readonly string[];
}

export const NON_VENUES: readonly NonVenue[] = [
  {
    what: "parking",
    osm: ["amenity=parking", "amenity=parking_space", "amenity=parking_entrance", "amenity=bicycle_parking", "amenity=motorcycle_parking"],
    foursquare: ["Travel and Transportation > Parking"],
    overture: ["parking"],
  },
  {
    what: "cash machines",
    osm: ["amenity=atm"],
    foursquare: ["Business and Professional Services > Financial Service > Banking and Finance > ATM"],
    overture: ["atm"],
  },
  {
    what: "charging stations",
    osm: ["amenity=charging_station"],
    foursquare: ["Travel and Transportation > Electric Vehicle Charging Station"],
    overture: ["ev_charging_station"],
  },
  {
    what: "toilets, drinking water, phones",
    osm: ["amenity=toilets", "amenity=drinking_water", "amenity=telephone"],
    foursquare: ["Community and Government > Public Bathroom"],
    overture: ["public_restroom", "drinking_fountain", "public_phone"],
  },
  {
    what: "vending machines and lockers",
    osm: ["amenity=vending_machine", "amenity=parcel_locker"],
    foursquare: [
      "Retail > Vending Machine",
      "Community and Government > Government Building > Post Office > Parcel Locker",
      "Travel and Transportation > Baggage Locker",
    ],
    overture: ["package_locker"],
  },
  {
    what: "bike and car sharing, taxi ranks",
    osm: ["amenity=bicycle_rental", "amenity=car_sharing", "amenity=taxi"],
    foursquare: ["Travel and Transportation > Bike Rental", "Travel and Transportation > Transport Hub > Taxi Stand"],
    overture: ["bike_sharing_location", "car_sharing", "taxi_stand"],
  },
  {
    what: "stops and platforms",
    osm: ["highway=bus_stop", "public_transport=platform", "public_transport=stop_position", "railway=platform"],
    foursquare: ["Travel and Transportation > Transport Hub > Bus Stop", "Travel and Transportation > Platform"],
    overture: [],
  },
  {
    // The street the user is on is offered separately, as the street level.
    what: "roads, crossings, toll booths, lifts",
    osm: ["highway=residential", "highway=crossing", "highway=elevator", "barrier=toll_booth"],
    foursquare: [
      "Travel and Transportation > Road",
      "Travel and Transportation > Street",
      "Travel and Transportation > Toll Booth",
      "Travel and Transportation > Toll Plaza",
      "Travel and Transportation > Elevator",
    ],
    overture: ["public_pathway", "toll_station"],
  },
  {
    what: "playgrounds, dog parks, picnic sites",
    osm: ["leisure=playground", "leisure=dog_park", "leisure=picnic_table", "tourism=picnic_site", "amenity=shelter"],
    foursquare: [
      "Landmarks and Outdoors > Park > Playground",
      "Landmarks and Outdoors > Park > Dog Park",
      "Landmarks and Outdoors > Park > Picnic Area",
      "Landmarks and Outdoors > Picnic Shelter",
    ],
    overture: ["playground", "dog_park"],
  },
  {
    // Also a privacy matter: Foursquare's "Home (private)" is someone's home.
    what: "homes and residential buildings",
    osm: ["building=house", "building=apartments", "landuse=residential"],
    foursquare: [
      "Community and Government > Residential Building",
      "Community and Government > Housing Development",
      "Community and Government > Trailer Park",
    ],
    overture: ["apartment", "condominium", "mobile_home_park"],
  },
  {
    // A train or a flight, placed wherever someone first created it.
    what: "vehicles",
    osm: [],
    foursquare: [
      "Travel and Transportation > Train",
      "Travel and Transportation > Transport Hub > Airport > Plane",
      "Travel and Transportation > Transportation Service > Public Transportation > Bus Line",
      "Travel and Transportation > Moving Target",
    ],
    overture: ["train"],
  },
  {
    // Offered as areas, from Overture's boundaries.
    what: "countries, cities, neighbourhoods",
    osm: ["place=city", "place=town", "place=village", "place=suburb", "place=neighbourhood"],
    foursquare: ["Landmarks and Outdoors > States and Municipalities"],
    overture: [],
  },
];

const escapeRegExp = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

// One pattern for all Foursquare non-venue labels and what is below them. Labels are
// matched as written (they are a fixed taxonomy), so this does not lower-case.
const FOURSQUARE_NON_VENUE = `^(${NON_VENUES.flatMap((n) => n.foursquare).map(escapeRegExp).join("|")})( > |$)`;
const OVERTURE_NON_VENUE = new Set(NON_VENUES.flatMap((n) => n.overture));
const foursquareNonVenue = new RegExp(FOURSQUARE_NON_VENUE);

// `label` is one Foursquare category label, e.g. "Travel and Transportation > Parking".
export function isFoursquareNonVenue(label: string): boolean {
  return foursquareNonVenue.test(label);
}

// `categories` are an Overture place's taxonomy hierarchy plus its basic category.
export function isOvertureNonVenue(categories: ReadonlyArray<string | null>): boolean {
  return categories.some((c) => c !== null && OVERTURE_NON_VENUE.has(c));
}

// The same as DuckDB macros, `foursquare_non_venue(label)` and
// `overture_non_venue(categories)`, for the extraction.
export function nonVenueMacroSql(): string {
  const overture = [...OVERTURE_NON_VENUE].map((c) => `'${c.replaceAll("'", "''")}'`).join(", ");
  return [
    `CREATE OR REPLACE MACRO foursquare_non_venue(label) AS regexp_matches(coalesce(label, ''), '${FOURSQUARE_NON_VENUE.replaceAll("'", "''")}')`,
    `CREATE OR REPLACE MACRO overture_non_venue(categories) AS list_has_any(categories, [${overture}])`,
  ].join(";\n");
}
