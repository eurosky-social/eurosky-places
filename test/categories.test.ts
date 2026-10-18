import assert from "node:assert/strict";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  categoryGroup,
  categoryGroupMacroSql,
  isFoursquareNonVenue,
  isOvertureNonVenue,
  NON_VENUES,
  nonVenueMacroSql,
  type CategoryGroup,
} from "../src/places/categories.ts";

// Real category strings from the Berlin/Madrid samples (Overture basic_category plus
// taxonomy, Foursquare category paths).
const EXAMPLES: Array<[string, CategoryGroup]> = [
  ["coffee_shop food_and_drink > cafe", "food_drink"],
  ["casual_eatery", "food_drink"],
  ["fast_food_restaurant", "food_drink"],
  ["Dining and Drinking > Bar > Pub", "food_drink"],
  ["Dining and Drinking > Bakery", "food_drink"],
  ["train_station", "transit"],
  ["Travel and Transportation > Transport Hub > Metro Station", "transit"],
  ["hotel", "lodging"],
  ["Travel and Transportation > Lodging > Hostel", "lodging"],
  ["museum", "culture"],
  ["Arts and Entertainment > Music Venue", "culture"],
  ["theme_park", "culture"],
  ["Landmarks and Outdoors > Park", "nature"],
  ["skate_park sports_and_recreation > sport_or_fitness_facility > skate_park", "nature"],
  ["parking", "services"],
  ["public_plaza", "sights"],
  ["landmark_and_historical_building", "sights"],
  ["Landmarks and Outdoors > Monument", "sights"],
  ["Retail > Fashion Retail > Women's Store", "shopping"],
  ["Retail > Food and Beverage Retail > Grocery Store", "shopping"],
  ["Business and Professional Services > Advertising Agency", "services"],
  ["bank_or_credit_union", "services"],
  ["attorney_or_law_firm", "services"],
  ["barber", "other"],
  ["", "other"],
  // OpenStreetMap tags (key=value)
  ["amenity=restaurant", "food_drink"],
  ["railway=station", "transit"],
  ["railway=halt", "transit"],
  ["public_transport=station", "transit"],
  ["aeroway=terminal", "transit"],
  ["amenity=bus_station", "transit"],
  ["tourism=museum", "culture"],
  ["leisure=park", "nature"],
  ["natural=peak", "nature"],
  ["historic=memorial", "sights"],
  ["amenity=place_of_worship", "sights"],
  ["place=square", "sights"],
  ["shop=clothes", "shopping"],
  ["office=company", "services"],
  ["amenity=school", "services"],
  ["leisure=fitness_centre", "other"],
  // Words that are also parts of other words (EUR-480: ~1.4 million furniture and
  // hardware stores were "nature", tour operators "culture").
  ["hardware_home_and_garden_store shopping > specialty_store > hardware_home_and_garden_store > furniture_store", "shopping"],
  ["Retail > Garden Center", "shopping"],
  ["shop=garden_centre", "shopping"],
  ["home_service services_and_business > home_service > landscaping > gardener", "services"],
  ["Business and Professional Services > Home Improvement Service > Landscaper and Gardener", "services"],
  ["Business and Professional Services > Agriculture and Forestry Service", "services"],
  ["natural_gas_utility_provider community_and_government > public_utility > natural_gas_utility_provider", "services"],
  ["Landmarks and Outdoors > Garden > Community Garden", "nature"],
  ["garden geographic_entities > built_feature > garden > botanical_garden", "nature"],
  ["Landmarks and Outdoors > Park > Natural Park", "nature"],
  ["leisure=garden", "nature"],
  ["travel_service travel_and_transportation > travel_service > tour_operator", "services"],
  ["travel_service travel_and_transportation > travel_service > tour_operator > historical_tour", "services"],
  ["b2b_service services_and_business > b2b_service > b2b_agriculture_service > agricultural_cooperative", "services"],
  ["Arts and Entertainment > Performing Arts Venue > Opera House", "culture"],
  ["music_venue arts_and_entertainment > performing_arts_venue > music_venue > opera_and_ballet", "culture"],
  ["books_music_and_video_store shopping > specialty_store > books_music_and_video_store > bookstore", "shopping"],
  ["musical_instrument_and_pro_audio_store shopping > specialty_store > musical_instrument_and_pro_audio_store", "shopping"],
  ["Retail > Music Store", "shopping"],
  ["shop=music", "shopping"],
  ["media_service services_and_business > media_service > media_news_company > music_production", "services"],
  ["Arts and Entertainment > Performing Arts Venue > Music Venue > Jazz and Blues Venue", "culture"],
  ["specialty_school education > place_of_learning > specialty_school > music_school", "culture"],
  ["amenity=music_school", "culture"],
  ["media_service services_and_business > media_service > theatrical_production", "services"],
  ["media_service services_and_business > media_service > media_news_company > movie_television_studio", "services"],
  ["electronics_store shopping > specialty_store > electronics_store > home_theater_systems_stores", "shopping"],
  ["movie_theater arts_and_entertainment > movie_theater > drive_in_theater", "culture"],
  ["amenity=theatre", "culture"],
  ["Community and Government > Spiritual Center > Shrine", "sights"],
  ["Community and Government > Cemetery", "sights"],
  ["animal_or_pet_service lifestyle_services > animal_or_pet_service > pet_cemetery_and_crematorium_service", "services"],
  ["Travel and Transportation > Transport Hub > Rental Car Location", "services"],
];

test("categoryGroup sorts real source categories into groups", () => {
  for (const [description, expected] of EXAMPLES) {
    assert.equal(categoryGroup(description), expected, description);
  }
});

test("the DuckDB macro gives the same groups as categoryGroup", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();
  try {
    await con.run(categoryGroupMacroSql());
    const values = EXAMPLES.map(([d], i) => `(${i}, '${d.replaceAll("'", "''")}')`).join(", ");
    const reader = await con.runAndReadAll(
      `SELECT i, category_group(d) FROM (VALUES ${values}) AS t(i, d) ORDER BY i`,
    );
    const fromSql = reader.getRows().map((row) => row[1]);
    assert.deepEqual(
      fromSql,
      EXAMPLES.map(([d]) => categoryGroup(d)),
    );
  } finally {
    con.closeSync();
    instance.closeSync();
  }
});

// Real labels and taxonomy paths: things the load leaves out, and close neighbours it keeps
// (plus one made-up label that only starts like a non-venue).
const FOURSQUARE_LABELS: Array<[string, boolean]> = [
  ["Travel and Transportation > Parking", true],
  ["Business and Professional Services > Financial Service > Banking and Finance > ATM", true],
  ["Travel and Transportation > Electric Vehicle Charging Station", true],
  ["Community and Government > Public Bathroom", true],
  ["Travel and Transportation > Transport Hub > Bus Stop", true],
  ["Travel and Transportation > Road > Intersection", true],
  ["Community and Government > Residential Building > Home (private)", true],
  ["Landmarks and Outdoors > Park > Playground", true],
  ["Landmarks and Outdoors > States and Municipalities > City", true],
  ["Travel and Transportation > Transport Hub > Airport > Plane", true],
  ["Travel and Transportation > Transport Hub > Bus Station", false],
  ["Travel and Transportation > Transport Hub > Airport", false],
  ["Travel and Transportation > Transport Hub > Airport > Airport Terminal", false],
  ["Travel and Transportation > Fuel Station", false],
  ["Travel and Transportation > Rest Area", false],
  ["Travel and Transportation", false],
  ["Landmarks and Outdoors > Park", false],
  ["Landmarks and Outdoors > Park > Urban Park", false],
  ["Business and Professional Services > Financial Service > Banking and Finance > Bank", false],
  ["Community and Government > Residential Building Society", false],
  ["Dining and Drinking > Cafe", false],
];

const OVERTURE_CATEGORIES: Array<[Array<string | null>, boolean]> = [
  [["travel_and_transportation", "parking", "parking_garage", "parking_garage"], true],
  [["travel_and_transportation", "parking", "bike_parking", "parking"], true],
  [["services_and_business", "financial_service", "atm", "atm"], true],
  [["travel_and_transportation", "fueling_station", "ev_charging_station", "ev_charging_station"], true],
  [["community_and_government", "public_facility", "public_restroom", "public_restroom"], true],
  [["sports_and_recreation", "park", "playground", "playground"], true],
  [["services_and_business", "housing_or_property_service", "apartment", "apartment"], true],
  [["parking"], true], // a record without a hierarchy, only a basic category
  [["sports_and_recreation", "park", "park"], false],
  [["sports_and_recreation", "park", "national_park", "national_park"], false],
  [["travel_and_transportation", "fueling_station", "gas_station", "gas_station"], false],
  [["services_and_business", "financial_service", "bank_or_credit_union", "bank_or_credit_union"], false],
  [["services_and_business", "housing_or_property_service", "senior_living_facility", "retirement_home", "senior_living_facility"], false],
  [["food_and_drink", "casual_eatery", "cafe", null], false],
  [[], false],
];

test("parking, cash machines, homes and the like are recognised in both taxonomies", () => {
  for (const [label, excluded] of FOURSQUARE_LABELS) {
    assert.equal(isFoursquareNonVenue(label), excluded, label);
  }
  for (const [categories, excluded] of OVERTURE_CATEGORIES) {
    assert.equal(isOvertureNonVenue(categories), excluded, categories.join(" > "));
  }
});

test("the DuckDB non-venue macros agree with the TypeScript checks", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();
  try {
    await con.run(nonVenueMacroSql());
    const labels = FOURSQUARE_LABELS.map(([l], i) => `(${i}, '${l.replaceAll("'", "''")}')`).join(", ");
    const fsq = await con.runAndReadAll(
      `SELECT foursquare_non_venue(l) FROM (VALUES ${labels}) AS t(i, l) ORDER BY i`,
    );
    assert.deepEqual(
      fsq.getRows().map((row) => row[0]),
      FOURSQUARE_LABELS.map(([l]) => isFoursquareNonVenue(l)),
    );
    const lists = OVERTURE_CATEGORIES.map(
      ([c], i) => `(${i}, [${c.map((x) => (x === null ? "NULL" : `'${x}'`)).join(", ")}]::VARCHAR[])`,
    ).join(", ");
    const overture = await con.runAndReadAll(
      `SELECT overture_non_venue(c) FROM (VALUES ${lists}) AS t(i, c) ORDER BY i`,
    );
    assert.deepEqual(
      overture.getRows().map((row) => row[0]),
      OVERTURE_CATEGORIES.map(([c]) => isOvertureNonVenue(c)),
    );
    // A missing label is no reason to leave a place out.
    const missing = await con.runAndReadAll("SELECT foursquare_non_venue(NULL)");
    assert.equal(missing.getRows()[0]![0], false);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
});

test("the non-venue lists are written in each source's own terms", () => {
  for (const n of NON_VENUES) {
    assert.ok(n.foursquare.length + n.overture.length > 0, `${n.what}: nothing to leave out`);
    for (const label of n.foursquare) assert.match(label, /^[A-Z][^>]* > /, `${n.what}: "${label}" is a full label`);
    for (const id of n.overture) assert.match(id, /^[a-z_]+$/, `${n.what}: "${id}" is a taxonomy ID`);
    for (const tag of n.osm) assert.match(tag, /^[a-z_]+=[a-z_]+$/, `${n.what}: "${tag}" is key=value`);
  }
});
