// The check-in listener: place pins (social.eurosky.place.pin, docs/place-pin.md) as they
// are published anywhere on the network, from Jetstream into the check-in counts
// (live.checkins). A pin that names a place by its ATGeo URN counts for that place; an
// edited pin counts where it points now, or no longer once it names no place; a deleted pin
// stops counting. It runs as its own process (`npm run listen`) and keeps its position in
// the stream in meta.listener_cursors, so a restart, or an outage shorter than Jetstream's
// replay window, loses nothing: what arrives twice is recorded once (check-ins are keyed by
// the record's URI).
import { loadConfig } from "./config.ts";
import { createPool, type Pool } from "./db.ts";
import { recordCheckins, type CheckinEvent } from "./live.ts";

export const PIN_COLLECTION = "social.eurosky.place.pin";

const URN = /^urn:atgeo:[^:]+:[^:]+:.+$/;
const DID = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;
// live.place_snapshots keeps up to 500 characters of a name (the HTTP route's limit too).
const NAME_MAX = 500;

type Operation = "create" | "update" | "delete";

interface JetstreamEvent {
  did?: unknown;
  time_us?: unknown;
  kind?: unknown;
  commit?: { operation?: unknown; collection?: unknown; rkey?: unknown; record?: unknown };
}

interface PinRecord {
  createdAt?: unknown;
  place?: { origin?: unknown; name?: unknown; locations?: unknown };
}

// The point of a pin's place, if it has a community.lexicon.location.geo one.
function geoPoint(locations: unknown): { lat: number; lng: number } | undefined {
  if (!Array.isArray(locations)) return undefined;
  for (const l of locations as Array<Record<string, unknown>>) {
    if (l?.$type !== "community.lexicon.location.geo") continue;
    const lat = Number(l.latitude);
    const lng = Number(l.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return undefined;
}

// A pin record as a check-in for its place, or null when it names no place we can count
// (no origin, say, for a pin at street level).
function pinCheckin(uri: string, record: unknown): CheckinEvent | null {
  const pin = record as PinRecord | undefined;
  const origin = pin?.place?.origin;
  if (typeof origin !== "string" || origin.length > 512 || !URN.test(origin)) return null;
  const at = typeof pin?.createdAt === "string" ? Date.parse(pin.createdAt) : NaN;
  if (!Number.isFinite(at)) return null;
  const event: CheckinEvent = { uri, action: "create", place: origin, createdAt: new Date(at).toISOString() };
  const name = pin?.place?.name;
  if (typeof name === "string" && name.trim()) event.name = name.trim().slice(0, NAME_MAX);
  const point = geoPoint(pin?.place?.locations);
  if (point) Object.assign(event, point);
  return event;
}

// One Jetstream message as a check-in event: a create, a delete, or null for anything we
// do not count (another collection, account and identity events, an unusable record).
export function toCheckin(event: JetstreamEvent): CheckinEvent | null {
  if (event.kind !== "commit" || !event.commit || event.commit.collection !== PIN_COLLECTION) return null;
  const { did } = event;
  const { rkey, operation } = event.commit;
  if (typeof did !== "string" || !DID.test(did) || typeof rkey !== "string" || !RKEY.test(rkey)) return null;
  const uri = `at://${did}/${PIN_COLLECTION}/${rkey}`;
  switch (operation as Operation) {
    case "delete":
      return { uri, action: "delete" };
    case "create":
      return pinCheckin(uri, event.commit.record);
    case "update":
      // An edit that leaves no countable place takes the check-in back.
      return pinCheckin(uri, event.commit.record) ?? { uri, action: "delete" };
    default:
      return null;
  }
}

export async function readCursor(pool: Pool, collection = PIN_COLLECTION): Promise<number | undefined> {
  const { rows } = await pool.query<{ time_us: string }>(
    "SELECT time_us FROM meta.listener_cursors WHERE collection = $1",
    [collection],
  );
  return rows[0] ? Number(rows[0].time_us) : undefined;
}

async function saveCursor(pool: Pool, timeUs: number, collection = PIN_COLLECTION): Promise<void> {
  await pool.query(
    `INSERT INTO meta.listener_cursors (collection, time_us) VALUES ($1, $2)
     ON CONFLICT (collection) DO UPDATE SET time_us = GREATEST(meta.listener_cursors.time_us, excluded.time_us), updated_at = now()`,
    [collection, timeUs],
  );
}

export interface SinkOptions {
  // Wait this long after a message for more before writing (default 250 ms).
  flushMs?: number;
  // Write at once when this many messages are waiting (default 500).
  maxBatch?: number;
}

// Collects messages from one connection and writes them in small batches, each followed
// by the position in the stream it reached. Writes run one at a time, in arrival order.
// A failed write calls onError; the connection should then be dropped and a new one
// started from the saved position, so nothing is lost.
export class CheckinSink {
  private queue: Array<{ timeUs: number; event: CheckinEvent | null }> = [];
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private failed = false;
  readonly totals = { created: 0, deleted: 0 };
  private readonly pool: Pool;
  private readonly onError: (error: unknown) => void;
  private readonly options: SinkOptions;

  constructor(pool: Pool, onError: (error: unknown) => void, options: SinkOptions = {}) {
    this.pool = pool;
    this.onError = onError;
    this.options = options;
  }

  push(raw: string): void {
    if (this.failed) return;
    let message: JetstreamEvent;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const timeUs = typeof message.time_us === "number" && Number.isSafeInteger(message.time_us) ? message.time_us : 0;
    this.queue.push({ timeUs, event: toCheckin(message) });
    if (this.queue.length >= (this.options.maxBatch ?? 500)) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.options.flushMs ?? 250);
  }

  // Writes everything received so far; resolves when it is stored.
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue.splice(0);
    if (!batch.length) return this.writing;
    this.writing = this.writing.then(async () => {
      if (this.failed) return;
      try {
        await this.write(batch);
      } catch (error) {
        this.failed = true;
        this.onError(error);
      }
    });
    return this.writing;
  }

  private async write(batch: Array<{ timeUs: number; event: CheckinEvent | null }>): Promise<void> {
    // The last word on each record wins: created and deleted in one batch is deleted.
    const latest = new Map<string, CheckinEvent>();
    for (const { event } of batch) if (event) latest.set(event.uri, event);
    if (latest.size) {
      const { created, deleted } = await recordCheckins(this.pool, [...latest.values()]);
      this.totals.created += created;
      this.totals.deleted += deleted;
    }
    const reached = Math.max(...batch.map((b) => b.timeUs));
    if (reached > 0) await saveCursor(this.pool, reached);
  }
}

export function subscribeUrl(base: string, cursor: number | undefined): string {
  const url = new URL(base);
  url.searchParams.set("wantedCollections", PIN_COLLECTION);
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

type Log = (message: string) => void;

// One connection: resolves when it closes, for any reason.
function listenOnce(pool: Pool, base: string, cursor: number | undefined, log: Log, stopping: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(subscribeUrl(base, cursor));
    const sink = new CheckinSink(pool, (error) => {
      log(`writing check-ins failed, reconnecting: ${(error as Error).message}`);
      socket.close();
    });
    const stop = () => socket.close();
    stopping.addEventListener("abort", stop, { once: true });
    socket.addEventListener("open", () => log(`connected${cursor === undefined ? "" : ` from ${new Date(cursor / 1000).toISOString()}`}`));
    socket.addEventListener("message", (m) => sink.push(typeof m.data === "string" ? m.data : ""));
    socket.addEventListener("error", () => {
      // "close" follows and does the rest.
    });
    socket.addEventListener("close", async () => {
      stopping.removeEventListener("abort", stop);
      await sink.flush();
      const { created, deleted } = sink.totals;
      log(`disconnected; this connection recorded ${created} check-ins and ${deleted} deletions`);
      resolve();
    });
  });
}

// Reconnects for ever, from the last saved position, waiting longer after each failure
// (up to a minute) and starting over once a connection has lasted.
export async function run(pool: Pool, base: string, log: Log, stopping: AbortSignal): Promise<void> {
  let wait = 1_000;
  while (!stopping.aborted) {
    const started = Date.now();
    await listenOnce(pool, base, await readCursor(pool), log, stopping);
    if (stopping.aborted) break;
    if (Date.now() - started > 60_000) wait = 1_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      stopping.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
    wait = Math.min(wait * 2, 60_000);
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 4);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  const log: Log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  log(`following ${PIN_COLLECTION} on ${config.jetstreamUrl}`);
  await run(pool, config.jetstreamUrl, log, controller.signal);
  await pool.end();
}
