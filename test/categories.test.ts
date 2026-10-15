import assert from "node:assert/strict";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { categoryGroup, categoryGroupMacroSql, type CategoryGroup } from "../src/places/categories.ts";

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
  ["dog_park", "nature"],
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
