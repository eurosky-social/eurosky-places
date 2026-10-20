import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  // Shared secret for /internal/* (check-in listener, admin overrides); unset disables them.
  internalToken: string | undefined;
  // The public URL answers link to, e.g. https://places.eurosky.tech; unset: from the request.
  publicBaseUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const internalToken = env.INTERNAL_TOKEN || undefined;
  if (internalToken && internalToken.length < 32) {
    throw new Error("INTERNAL_TOKEN must be at least 32 characters");
  }
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://places:places@127.0.0.1:5433/places",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    internalToken,
    publicBaseUrl: env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, "") : undefined,
  };
}

// DuckDB, the loader, defaults to 80% of the machine's memory. On the production host
// Postgres needs its share, so the load sets a limit there; spill files go to the
// temp directory, which should be on a disk with room.
export interface DuckDBSettings {
  memoryLimit?: string;
  tempDirectory?: string;
}

export function duckdbSettings(env: NodeJS.ProcessEnv = process.env): DuckDBSettings {
  return {
    memoryLimit: env.DUCKDB_MEMORY_LIMIT || undefined,
    tempDirectory: env.DUCKDB_TEMP_DIRECTORY || undefined,
  };
}

// osm2pgsql's node position cache in MB. Its default (800) suits an extract; the
// filtered planet needs a few GB to keep every lookup in memory.
export function osm2pgsqlCacheMb(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (!env.OSM2PGSQL_CACHE_MB) return undefined;
  const mb = Number(env.OSM2PGSQL_CACHE_MB);
  if (!Number.isInteger(mb) || mb <= 0) throw new Error("OSM2PGSQL_CACHE_MB must be a whole number of MB");
  return mb;
}

// The Foursquare dataset on Hugging Face is gated, so every download needs a token
// from an account that accepted the dataset's terms.
export function huggingFaceToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HF_TOKEN) return env.HF_TOKEN;
  try {
    return readFileSync(join(homedir(), ".huggingface", "token"), "utf8").trim();
  } catch {
    throw new Error("HF_TOKEN is not set and ~/.huggingface/token is missing");
  }
}
