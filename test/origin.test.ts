import assert from "node:assert/strict";
import { test } from "node:test";
import { DATASETS, parseOrigin, placeOrigin } from "../src/places/origin.ts";

test("placeOrigin builds ATGeo place URNs", () => {
  assert.equal(placeOrigin(DATASETS.osm, "way", "123"), "urn:atgeo:openstreetmap.org:way:123");
  assert.equal(
    placeOrigin(DATASETS.overture, "place", "00d124c8-6d72-4f51-86ad-f7eb75c5bc75"),
    "urn:atgeo:overturemaps.org:place:00d124c8-6d72-4f51-86ad-f7eb75c5bc75",
  );
});

test("placeOrigin rejects colons in dataset and collection, and empty ids", () => {
  assert.throws(() => placeOrigin("a:b", "place", "1"));
  assert.throws(() => placeOrigin(DATASETS.osm, "way:x", "1"));
  assert.throws(() => placeOrigin(DATASETS.osm, "way", ""));
});

test("parseOrigin keeps everything after the fourth colon as the id", () => {
  assert.deepEqual(parseOrigin("urn:atgeo:example.org:thing:a:b:c"), {
    dataset: "example.org",
    collection: "thing",
    id: "a:b:c",
  });
  assert.throws(() => parseOrigin("https://example.org/place/1"));
});
