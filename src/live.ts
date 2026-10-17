// Live data that survives the monthly reference swap: check-ins per place, our own
// overrides, and what it takes to follow a place whose ID changes between releases.
import { withTransaction, type Client, type Pool } from "./db.ts";
import { isLeadingWords, normalizeName, similarEnough } from "./places/names.ts";

export interface CheckinEvent {
  uri: string; // the check-in record's at:// URI
  action?: "create" | "delete";
  place?: string; // ATGeo URN of the place, required for create
  createdAt?: string; // ISO timestamp, required for create
  // The place as the app published it; used when the place is not in our data.
  name?: string;
  lat?: number;
  lng?: number;
}

export interface Counts {
  total: number;
  last30d: number;
}

export interface Override {
  placeKey: string;
  hidden: boolean;
  name: string | null;
  note: string | null;
  updatedAt?: string;
}

// An ID retired by a load may still be in apps' caches and in records published since;
// map it to where its data went.
async function resolveKeys(client: Client | Pool, keys: string[]): Promise<Map<string, string>> {
  const { rows } = await client.query<{ old_key: string; new_key: string }>(
    "SELECT old_key, new_key FROM live.key_moves WHERE old_key = ANY($1)",
    [keys],
  );
  return new Map(rows.map((r) => [r.old_key, r.new_key]));
}

// Remembers a place's name and position the first time we hold live data for it: from
// our reference data if it is there, otherwise from what the app published.
async function snapshot(client: Client, key: string, fallback?: { name?: string; lat?: number; lng?: number }) {
  const { rows } = await client.query("SELECT to_regclass('ref.places') IS NOT NULL AS loaded");
  const { rowCount } = rows[0].loaded
    ? await client.query(
        `INSERT INTO live.place_snapshots (place_key, name, geog)
         SELECT origin, name, geog FROM ref.places WHERE origin = $1
         ON CONFLICT (place_key) DO NOTHING`,
        [key],
      )
    : { rowCount: 0 };
  if (rowCount || !fallback?.name || fallback.lat === undefined || fallback.lng === undefined) return;
  await client.query(
    `INSERT INTO live.place_snapshots (place_key, name, geog)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography)
     ON CONFLICT (place_key) DO NOTHING`,
    [key, fallback.name, fallback.lat, fallback.lng],
  );
}

export async function recordCheckins(pool: Pool, events: CheckinEvent[]): Promise<{ created: number; deleted: number }> {
  const creates = events.filter((e) => (e.action ?? "create") === "create");
  const deletes = events.filter((e) => e.action === "delete").map((e) => e.uri);
  return withTransaction(pool, async (client) => {
    const moved = await resolveKeys(client, creates.map((e) => e.place!));
    for (const e of creates) {
      const key = moved.get(e.place!) ?? e.place!;
      // A record edited after publishing arrives again under the same URI.
      await client.query(
        `INSERT INTO live.checkins (uri, place_key, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (uri) DO UPDATE SET place_key = excluded.place_key, created_at = excluded.created_at`,
        [e.uri, key, e.createdAt],
      );
      await snapshot(client, key, e);
    }
    const { rowCount } = deletes.length
      ? await client.query("DELETE FROM live.checkins WHERE uri = ANY($1)", [deletes])
      : { rowCount: 0 };
    return { created: creates.length, deleted: rowCount ?? 0 };
  });
}

const toOverride = (r: Record<string, any>): Override => ({
  placeKey: r.place_key,
  hidden: r.hidden,
  name: r.name,
  note: r.note,
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
});

export interface LiveData {
  counts: Map<string, Counts>;
  overrides: Map<string, Pick<Override, "hidden" | "name">>;
}

// Check-in counts and overrides for a set of place IDs, in one round trip: suggestions
// ask for hundreds of IDs on every request.
export async function liveDataFor(pool: Pool, keys: string[]): Promise<LiveData> {
  const data: LiveData = { counts: new Map(), overrides: new Map() };
  if (!keys.length) return data;
  const { rows } = await pool.query<{ key: string; total: number; last_30d: number; hidden: boolean | null; name: string | null }>(
    `WITH keys AS (SELECT DISTINCT unnest($1::text[]) AS key),
     counts AS (
       SELECT place_key AS key, count(*)::int AS total,
              (count(*) FILTER (WHERE created_at > now() - interval '30 days'))::int AS last_30d
       FROM live.checkins WHERE place_key IN (SELECT key FROM keys) GROUP BY place_key
     )
     SELECT k.key, coalesce(c.total, 0) AS total, coalesce(c.last_30d, 0) AS last_30d, o.hidden, o.name
     FROM keys k
     LEFT JOIN counts c USING (key)
     LEFT JOIN live.place_overrides o ON o.place_key = k.key
     WHERE c.key IS NOT NULL OR o.place_key IS NOT NULL`,
    [keys],
  );
  for (const r of rows) {
    if (r.total) data.counts.set(r.key, { total: r.total, last30d: r.last_30d });
    if (r.hidden !== null) data.overrides.set(r.key, { hidden: r.hidden, name: r.name });
  }
  return data;
}

export async function listOverrides(pool: Pool): Promise<Override[]> {
  const { rows } = await pool.query("SELECT * FROM live.place_overrides ORDER BY updated_at DESC");
  return rows.map(toOverride);
}

export async function setOverride(
  pool: Pool,
  key: string,
  change: { hidden?: boolean; name?: string | null; note?: string | null },
): Promise<Override> {
  return withTransaction(pool, async (client) => {
    const target = (await resolveKeys(client, [key])).get(key) ?? key;
    const { rows } = await client.query(
      `INSERT INTO live.place_overrides (place_key, hidden, name, note)
       VALUES ($1, coalesce($2, false), $3, $4)
       ON CONFLICT (place_key) DO UPDATE SET
         hidden = coalesce($2, live.place_overrides.hidden),
         name = CASE WHEN $5 THEN $3 ELSE live.place_overrides.name END,
         note = CASE WHEN $6 THEN $4 ELSE live.place_overrides.note END,
         updated_at = now()
       RETURNING *`,
      [target, change.hidden ?? null, change.name ?? null, change.note ?? null, "name" in change, "note" in change],
    );
    await snapshot(client, target);
    return toOverride(rows[0]!);
  });
}

export async function deleteOverride(pool: Pool, key: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM live.place_overrides WHERE place_key = $1", [key]);
  return Boolean(rowCount);
}

// Same thresholds as merging suggestions (src/places/rank.ts).
const REATTACH_DISTANCE_M = 75;
const REATTACH_LEADING_WORDS_M = 50;

export interface ReattachResult {
  orphans: number;
  moved: Array<{ from: string; to: string }>;
  unmatched: string[];
}

// After a load: live data whose place ID is no longer in the reference data moves to
// the same place under its new ID, found by name within 75 m of where the place was.
// Overture retires IDs often (~6–12% a month in 2026); Foursquare and OSM rarely.
export async function reattachOrphans(pool: Pool): Promise<ReattachResult> {
  const { rows: orphans } = await pool.query<{ place_key: string; name: string; lng: number; lat: number }>(
    `SELECT s.place_key, s.name, ST_X(s.geog::geometry) AS lng, ST_Y(s.geog::geometry) AS lat
     FROM live.place_snapshots s
     WHERE NOT EXISTS (SELECT 1 FROM ref.places p WHERE p.origin = s.place_key)
     ORDER BY s.place_key`,
  );
  const result: ReattachResult = { orphans: orphans.length, moved: [], unmatched: [] };
  for (const orphan of orphans) {
    const { rows: nearby } = await pool.query<{ origin: string; name: string; distance: number }>(
      `WITH here AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g)
       SELECT p.origin, p.name, ST_Distance(p.geog, here.g) AS distance
       FROM ref.places p, here WHERE ST_DWithin(p.geog, here.g, $3)
       ORDER BY p.geog <-> here.g LIMIT 50`,
      [orphan.lng, orphan.lat, REATTACH_DISTANCE_M],
    );
    const key = normalizeName(orphan.name);
    const match = nearby.find((p) => {
      const other = normalizeName(p.name);
      return similarEnough(key, other, 0.9) || (p.distance <= REATTACH_LEADING_WORDS_M && isLeadingWords(key, other));
    });
    if (!match) {
      result.unmatched.push(orphan.place_key);
      continue;
    }
    await moveKey(pool, orphan.place_key, match.origin);
    result.moved.push({ from: orphan.place_key, to: match.origin });
  }
  return result;
}

async function moveKey(pool: Pool, from: string, to: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("UPDATE live.checkins SET place_key = $2 WHERE place_key = $1", [from, to]);
    // An override already on the new ID wins over the one being moved.
    await client.query(
      `UPDATE live.place_overrides SET place_key = $2 WHERE place_key = $1
         AND NOT EXISTS (SELECT 1 FROM live.place_overrides WHERE place_key = $2)`,
      [from, to],
    );
    await client.query("DELETE FROM live.place_overrides WHERE place_key = $1", [from]);
    await client.query("DELETE FROM live.place_snapshots WHERE place_key = $1", [from]);
    await snapshot(client, to);
    // Keep the move history flat: anything that pointed at the old ID now points here,
    // and the new ID is current, so it no longer redirects anywhere.
    await client.query("UPDATE live.key_moves SET new_key = $2 WHERE new_key = $1", [from, to]);
    await client.query("DELETE FROM live.key_moves WHERE old_key = $1", [to]);
    await client.query(
      `INSERT INTO live.key_moves (old_key, new_key) VALUES ($1, $2)
       ON CONFLICT (old_key) DO UPDATE SET new_key = excluded.new_key, moved_at = now()`,
      [from, to],
    );
  });
}
