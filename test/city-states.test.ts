import assert from "node:assert/strict";
import { test } from "node:test";
import { CITY_STATE_IDS, cityStateField, isCityState } from "../src/places/city-states.ts";

test("the city-state list holds Wikidata IDs, each once", () => {
  for (const id of CITY_STATE_IDS) assert.match(id, /^Q\d+$/);
  const seen = new Set<string>();
  const duplicates = CITY_STATE_IDS.filter((id) => seen.size === seen.add(id).size);
  assert.deepEqual(duplicates, []);
});

test("cities filed as regions are city-states; states with several cities are not", () => {
  for (const city of ["Q64", "Q1055", "Q1741"]) assert.ok(isCityState(city), city); // Berlin, Hamburg, Vienna
  // Bremen (two cities), the Brussels-Capital Region (not the City of Brussels), Tokyo
  // (a prefecture), the District of Columbia (Washington is its own item).
  for (const region of ["Q1209", "Q240", "Q1490", "Q3551781"]) assert.ok(!isCityState(region), region);
  assert.ok(!isCityState(null));
  assert.ok(!isCityState(""));
});

test("the answer field is there only when true", () => {
  assert.deepEqual(cityStateField("Q64"), { cityState: true });
  assert.deepEqual(cityStateField("Q183"), {});
  assert.deepEqual(cityStateField(null), {});
});
