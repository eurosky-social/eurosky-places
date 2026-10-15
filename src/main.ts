import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp({ pool, logger: true, internalToken: config.internalToken });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}

await app.listen({ host: config.host, port: config.port });
