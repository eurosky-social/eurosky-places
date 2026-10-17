import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { foursquareCutoff } from "../src/load/extract.ts";
import {
  compareOvertureReleases,
  downloadFoursquare,
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

const RELEASE_DIR = "release/dt=2026-10-15/places/parquet";

// A Hugging Face stand-in: the file listing, and each file's body (or a function of the
// attempt number returning a Response), recording every request.
function fakeHub(files: Record<string, string | ((attempt: number) => Response)>) {
  const requests: Array<{ url: string; auth?: string }> = [];
  const attempts = new Map<string, number>();
  const fetchFn: FetchFn = async (url, init) => {
    requests.push({ url, auth: init?.headers?.Authorization });
    if (url.endsWith(`/tree/main/${RELEASE_DIR}`)) {
      return Response.json(
        Object.entries(files).map(([name, body]) => ({
          type: "file",
          path: `${RELEASE_DIR}/${name}`,
          lfs: { size: typeof body === "string" ? body.length : 3 },
        })),
      );
    }
    const name = Object.keys(files).find((n) => url.endsWith(`/resolve/main/${RELEASE_DIR}/${n}`));
    if (!name) return new Response("not found", { status: 404 });
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    const body = files[name]!;
    return typeof body === "string" ? new Response(body) : body(attempt);
  };
  return { fetchFn, requests, attempts };
}

async function inTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "foursquare-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("downloadFoursquare fetches each place file whole, one request per file", () =>
  inTempDir(async (dir) => {
    const hub = fakeHub({ "places_000000.parquet": "abc", "places_000001.parquet": "de" });
    const result = await downloadFoursquare({ release: "2026-10-15", token: "secret", dir, fetchFn: hub.fetchFn });
    assert.deepEqual(result, { glob: join(dir, "*.parquet"), files: 2, bytes: 5 });
    assert.deepEqual((await readdir(dir)).sort(), ["places_000000.parquet", "places_000001.parquet"]);
    assert.equal(await readFile(join(dir, "places_000000.parquet"), "utf8"), "abc");
    assert.equal(hub.requests.filter((r) => r.url.includes("/resolve/main/")).length, 2);
    assert.ok(hub.requests.every((r) => r.auth === "Bearer secret"));
  }));

test("downloadFoursquare waits out rate limits and server errors, but not a refusal", () =>
  inTempDir(async (dir) => {
    const flaky = fakeHub({
      "places_000000.parquet": (attempt) =>
        attempt === 1 ? new Response("slow down", { status: 429 })
        : attempt === 2 ? new Response("oops", { status: 503 })
        : new Response("abc"),
    });
    await downloadFoursquare({ release: "2026-10-15", token: "t", dir, fetchFn: flaky.fetchFn, retryDelayMs: 1 });
    assert.equal(flaky.attempts.get("places_000000.parquet"), 3);

    const refused = fakeHub({ "places_000000.parquet": () => new Response("no", { status: 403 }) });
    await assert.rejects(
      downloadFoursquare({ release: "2026-10-15", token: "t", dir, fetchFn: refused.fetchFn, retryDelayMs: 1 }),
      /HTTP 403/,
    );
    assert.equal(refused.attempts.get("places_000000.parquet"), 1);

    const short = fakeHub({ "places_000000.parquet": () => new Response("ab") });
    await assert.rejects(
      downloadFoursquare({ release: "2026-10-15", token: "t", dir, fetchFn: short.fetchFn, retryDelayMs: 1 }),
      /2 bytes, expected 3/,
    );
    assert.equal(short.attempts.get("places_000000.parquet"), 6);
  }));
