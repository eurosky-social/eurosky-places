// Finds the newest *complete* release of each source. A release can appear in a listing
// before all of its files are uploaded, so each candidate is checked for the parts we load.

export type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

const OVERTURE_BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com";
const OVERTURE_PARTS = [
  "theme=places/type=place/",
  "theme=divisions/type=division/",
  "theme=divisions/type=division_area/",
  "theme=addresses/type=address/",
];

export function overturePath(release: string, part: "places" | "divisions" | "areas" | "addresses"): string {
  const type = {
    places: "theme=places/type=place",
    divisions: "theme=divisions/type=division",
    areas: "theme=divisions/type=division_area",
    addresses: "theme=addresses/type=address",
  }[part];
  return `s3://overturemaps-us-west-2/release/${release}/${type}/*.parquet`;
}

export function parseOvertureReleases(listingXml: string): string[] {
  return [...listingXml.matchAll(/<Prefix>release\/([^<\/]+)\/<\/Prefix>/g)].map((m) => m[1]!);
}

// Releases look like "2026-09-23.1". The minor part is compared as a number, so a
// hypothetical "2026-09-23.10" still sorts after "2026-09-23.9".
export function compareOvertureReleases(a: string, b: string): number {
  const [da = "", ma = "0"] = a.split(".");
  const [db = "", mb = "0"] = b.split(".");
  return da === db ? Number(ma) - Number(mb) : da < db ? -1 : 1;
}

async function s3KeyCount(fetchFn: FetchFn, prefix: string): Promise<number> {
  const res = await fetchFn(`${OVERTURE_BUCKET}/?list-type=2&max-keys=1&prefix=${encodeURIComponent(prefix)}`);
  if (!res.ok) throw new Error(`Overture listing failed: ${res.status}`);
  const match = (await res.text()).match(/<KeyCount>(\d+)<\/KeyCount>/);
  return Number(match?.[1] ?? 0);
}

export async function latestOvertureRelease(fetchFn: FetchFn = fetch): Promise<string> {
  const res = await fetchFn(`${OVERTURE_BUCKET}/?list-type=2&prefix=release/&delimiter=/`);
  if (!res.ok) throw new Error(`Overture release listing failed: ${res.status}`);
  const releases = parseOvertureReleases(await res.text()).sort(compareOvertureReleases).reverse();
  for (const release of releases) {
    const counts = await Promise.all(OVERTURE_PARTS.map((p) => s3KeyCount(fetchFn, `release/${release}/${p}`)));
    if (counts.every((n) => n > 0)) return release;
  }
  throw new Error("no complete Overture release found");
}

const FOURSQUARE_TREE = "https://huggingface.co/api/datasets/foursquare/fsq-os-places/tree/main";

export function foursquarePath(release: string): string {
  return `hf://datasets/foursquare/fsq-os-places/release/dt=${release}/places/parquet/*.parquet`;
}

export function parseFoursquareReleases(tree: Array<{ path: string; type: string }>): string[] {
  return tree
    .filter((e) => e.type === "directory")
    .map((e) => e.path.match(/^release\/dt=(\d{4}-\d{2}-\d{2})$/)?.[1])
    .filter((d): d is string => d !== undefined);
}

export async function latestFoursquareRelease(token: string, fetchFn: FetchFn = fetch): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetchFn(`${FOURSQUARE_TREE}/release`, { headers });
  if (!res.ok) throw new Error(`Foursquare release listing failed: ${res.status}`);
  const releases = parseFoursquareReleases(await res.json()).sort().reverse();
  for (const release of releases) {
    const files = await fetchFn(`${FOURSQUARE_TREE}/release/dt=${release}/places/parquet`, { headers });
    if (files.ok && ((await files.json()) as unknown[]).length > 0) return release;
  }
  throw new Error("no complete Foursquare release found");
}
