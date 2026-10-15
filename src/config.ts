import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  // Shared secret for /internal/* (check-in listener, admin overrides); unset disables them.
  internalToken: string | undefined;
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
  };
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
