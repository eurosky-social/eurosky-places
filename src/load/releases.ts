import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

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

const FOURSQUARE_FILES = "https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/main";

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
  lfs?: { size: number };
}

export interface DownloadOptions {
  release: string;
  token: string;
  dir: string;
  fetchFn?: FetchFn;
  concurrency?: number;
  // First wait before a retry; it doubles with every attempt (tests make it tiny).
  retryDelayMs?: number;
}

// Downloads one release's Foursquare place files whole into opts.dir. A worldwide load
// reads every file in full anyway, and DuckDB reading them remotely does so in many small
// range requests: Hugging Face allows 5,000 per 5 minutes ("resolvers", fixed window), and
// the parallel extraction ran into HTTP 429 on the production host. Whole files are one
// request each (~100 files, ~12 GB).
export async function downloadFoursquare(opts: DownloadOptions): Promise<{ glob: string; files: number; bytes: number }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const headers = { Authorization: `Bearer ${opts.token}` };
  const listing = await fetchFn(`${FOURSQUARE_TREE}/release/dt=${opts.release}/places/parquet`, { headers });
  if (!listing.ok) throw new Error(`Foursquare file listing failed: ${listing.status}`);
  const files = ((await listing.json()) as TreeEntry[]).filter((e) => e.type === "file" && e.path.endsWith(".parquet"));
  if (files.length === 0) throw new Error(`Foursquare ${opts.release} has no place files`);

  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]!;
      await downloadFile(fetchFn, `${FOURSQUARE_FILES}/${file.path}`, headers, join(opts.dir, basename(file.path)), {
        size: file.lfs?.size ?? file.size,
        retryDelayMs: opts.retryDelayMs ?? 5000,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, files.length) }, worker));
  const bytes = files.reduce((n, f) => n + (f.lfs?.size ?? f.size ?? 0), 0);
  return { glob: join(opts.dir, "*.parquet"), files: files.length, bytes };
}

const ATTEMPTS = 6;

// Retries what can pass (429, server errors, dropped connections, a short file), honouring
// Retry-After; refuses at once what cannot (401, 403, 404).
async function downloadFile(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  dest: string,
  opts: { size?: number; retryDelayMs: number },
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let wait = opts.retryDelayMs * 2 ** (attempt - 1);
    try {
      const res = await fetchFn(url, { headers });
      if (!res.ok || !res.body) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        const error = new Error(`download of ${url} failed: HTTP ${res.status}`);
        if (!retryable) throw Object.assign(error, { final: true });
        const retryAfter = Number(res.headers.get("retry-after"));
        if (retryAfter > 0) wait = Math.min(retryAfter, 300) * 1000;
        throw error;
      }
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(dest));
      const actual = (await stat(dest)).size;
      if (opts.size !== undefined && actual !== opts.size) {
        throw new Error(`download of ${url} is ${actual} bytes, expected ${opts.size}`);
      }
      return;
    } catch (error) {
      if ((error as { final?: boolean }).final || attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
