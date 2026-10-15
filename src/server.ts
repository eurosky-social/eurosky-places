import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "./db.ts";
import { registerInternalRoutes } from "./internal.ts";
import { suggest, type SuggestRequest } from "./suggest.ts";

export interface AppOptions {
  pool: Pool;
  logger?: FastifyServerOptions["logger"];
  // Enables /internal/* when set.
  internalToken?: string;
}

// The position goes in the request body, never the URL: URLs end up in proxy, CDN and
// access logs along the way.
const suggestBody = {
  type: "object",
  required: ["lat", "lng"],
  additionalProperties: false,
  properties: {
    lat: { type: "number", minimum: -90, maximum: 90 },
    lng: { type: "number", minimum: -180, maximum: 180 },
    radius: { type: "integer", minimum: 50, maximum: 2000, default: 500 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
  },
} as const;

// Postgres error codes for a missing schema or table: no data load has run yet.
const NO_DATA_CODES = new Set(["3F000", "42P01"]);

export function buildApp({ pool, logger = false, internalToken }: AppOptions): FastifyInstance {
  // Per-request log lines stay off: requests carry users' positions, and nothing about
  // them should end up in logs.
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    // Refuse unknown fields instead of dropping them, so a client sending `lon` instead
    // of `lng` gets an error rather than a quiet wrong answer.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get("/health", async () => {
    const { rows } = await pool.query(
      "SELECT loaded_at, sources, bbox, counts FROM meta.releases ORDER BY id DESC LIMIT 1",
    );
    return { status: "ok", release: rows[0] ?? null };
  });

  // Endpoint A: what someone at this position could attach to a check-in or photo.
  app.post<{ Body: SuggestRequest }>("/v1/suggestions", { schema: { body: suggestBody } }, async (request, reply) => {
    // Answers depend on the user's exact position: nothing along the way may keep them.
    reply.header("Cache-Control", "no-store");
    try {
      return await suggest(pool, request.body);
    } catch (error) {
      if (NO_DATA_CODES.has((error as { code?: string }).code ?? "")) {
        return reply.code(503).send({ error: "NoData", message: "no place data has been loaded yet" });
      }
      throw error;
    }
  });

  if (internalToken) registerInternalRoutes(app, pool, internalToken);

  return app;
}
