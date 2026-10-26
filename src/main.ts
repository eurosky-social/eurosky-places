import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { PUBLIC_RATE_LIMITS } from "./limits.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl, undefined, {
  statementTimeoutMs: config.statementTimeoutMs,
  connectionTimeoutMs: 5_000,
});
const app = buildApp({
  pool,
  logger: true,
  internalToken: config.internalToken,
  publicBaseUrl: config.publicBaseUrl,
  rateLimits: PUBLIC_RATE_LIMITS,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}

await app.listen({ host: config.host, port: config.port });
