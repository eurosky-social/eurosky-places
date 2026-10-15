import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "./db.ts";

export interface AppOptions {
  pool: Pool;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({ pool, logger = false }: AppOptions): FastifyInstance {
  // Per-request log lines stay off: requests carry users' positions, and nothing about
  // them should end up in logs.
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });

  app.get("/health", async () => {
    const { rows } = await pool.query(
      "SELECT loaded_at, sources, bbox, counts FROM meta.releases ORDER BY id DESC LIMIT 1",
    );
    return { status: "ok", release: rows[0] ?? null };
  });

  return app;
}
