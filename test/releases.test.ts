import assert from "node:assert/strict";
import { test } from "node:test";
import { foursquareCutoff } from "../src/load/extract.ts";
import {
  compareOvertureReleases,
  latestFoursquareRelease,
  latestOvertureRelease,
  parseFoursquareReleases,
  parseOvertureReleases,
  type FetchFn,
} from "../src/load/releases.ts";

const listing = (prefixes: string[]) =>
  `<ListBucketResult>${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;

function fakeFetch(routes: Record<string, unknown>): FetchFn {
  return async (url) => {
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (match === undefined) return new Response("not found", { status: 404 });
    const body = routes[match];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
}

test("parseOvertureReleases reads release prefixes from an S3 listing", () => {
  assert.deepEqual(parseOvertureReleases(listing(["release/2026-08-19.0/", "release/2026-09-23.1/"])), [
    "2026-08-19.0",
    "2026-09-23.1",
  ]);
});

test("compareOvertureReleases orders by date, then by minor number", () => {
  const sorted = ["2026-09-23.10", "2026-08-19.0", "2026-09-23.9", "2026-09-23.1"].sort(compareOvertureReleases);
  assert.deepEqual(sorted, ["2026-08-19.0", "2026-09-23.1", "2026-09-23.9", "2026-09-23.10"]);
});

test("latestOvertureRelease skips a newer release that is still incomplete", async () => {
  const fetchFn = fakeFetch({
    "prefix=release%2F2026-10-21.0%2Ftheme%3Daddresses": "<KeyCount>0</KeyCount>",
    "prefix=release%2F2026-10-21.0": "<KeyCount>1</KeyCount>",
    "prefix=release%2F2026-09-23.1": "<KeyCount>1</KeyCount>",
    "prefix=release/&delimiter": listing(["release/2026-09-23.1/", "release/2026-10-21.0/"]),
  });
  assert.equal(await latestOvertureRelease(fetchFn), "2026-09-23.1");
});

test("parseFoursquareReleases reads dt= directories from the Hugging Face tree", () => {
  assert.deepEqual(
    parseFoursquareReleases([
      { path: "release/dt=2026-08-11", type: "directory" },
      { path: "release/dt=2026-09-15", type: "directory" },
      { path: "release/README.md", type: "file" },
    ]),
    ["2026-08-11", "2026-09-15"],
  );
});

test("latestFoursquareRelease skips a release without place files", async () => {
  const fetchFn = fakeFetch({
    "release/dt=2026-10-13/places/parquet": [],
    "release/dt=2026-09-15/places/parquet": [{ path: "places_000000.parquet", type: "file" }],
    "tree/main/release": [
      { path: "release/dt=2026-09-15", type: "directory" },
      { path: "release/dt=2026-10-13", type: "directory" },
    ],
  });
  assert.equal(await latestFoursquareRelease("token", fetchFn), "2026-09-15");
});

test("foursquareCutoff is two years before the release", () => {
  assert.equal(foursquareCutoff("2026-09-15"), "2024-09-15");
});
