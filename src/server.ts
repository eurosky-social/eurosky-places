import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { registerAtgeoRoutes } from "./atgeo.ts";
import type { Pool } from "./db.ts";
import { registerInternalRoutes } from "./internal.ts";
import { search, type SearchRequest } from "./search.ts";
import { parseSquare, SquareError, squareContents } from "./squares.ts";
import { suggest, type SuggestRequest } from "./suggest.ts";

export interface AppOptions {
  pool: Pool;
  logger?: FastifyServerOptions["logger"];
  // Enables /internal/* when set.
  internalToken?: string;
  // Places per page of a square (endpoint B).
  squarePageSize?: number;
  // This service's public URL, e.g. https://places.eurosky.tech, for links in answers;
  // without it they are built from the request.
  publicBaseUrl?: string;
}

// Square responses change only with a data load or live data (check-ins, overrides), so
// phones and the CDN may keep them for an hour.
const SQUARE_CACHE = "public, max-age=3600";

// Only `page` is allowed: anything else in the URL (a precise position appended by a
// careless client, say) is refused rather than ignored.
const squareQuery = {
  type: "object",
  additionalProperties: false,
  properties: { page: { type: "integer", minimum: 1, maximum: 1000, default: 1 } },
} as const;

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

// Type-ahead: what the user typed, and optionally where they are (both in the body).
const searchBody = {
  type: "object",
  required: ["q"],
  additionalProperties: false,
  properties: {
    q: { type: "string", minLength: 1, maxLength: 100 },
    lat: { type: "number", minimum: -90, maximum: 90 },
    lng: { type: "number", minimum: -180, maximum: 180 },
    limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
  },
  dependencies: { lat: ["lng"], lng: ["lat"] },
} as const;

// Postgres error codes for a missing schema or table: no data load has run yet.
const NO_DATA_CODES = new Set(["3F000", "42P01"]);

// Web apps on any origin may call the public endpoints (/v1/*) from the browser: every
// answer says so, errors included, and preflight requests are answered (a browser asks
// first before it POSTs JSON). No credentials: the endpoints need none.
// org.atgeo.getPlace allows any origin itself (src/atgeo.ts); /internal/* allows none.
const CORS_MAX_AGE = 86_400; // seconds a browser may reuse a preflight's answer

// A hook rather than a header set by the handler: it runs before the body is parsed and
// validated, so refused requests (400) carry the header too.
async function allowAnyOrigin(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header("Access-Control-Allow-Origin", "*");
}

function answerPreflight(app: FastifyInstance, url: string, method: "GET" | "POST"): void {
  app.options(url, async (_request, reply) =>
    reply
      .code(204)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", method)
      .header("Access-Control-Allow-Headers", "content-type")
      .header("Access-Control-Max-Age", String(CORS_MAX_AGE))
      .send(),
  );
}

export function buildApp({
  pool,
  logger = false,
  internalToken,
  squarePageSize = 500,
  publicBaseUrl,
}: AppOptions): FastifyInstance {
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
  app.post<{ Body: SuggestRequest }>(
    "/v1/suggestions",
    { schema: { body: suggestBody }, onRequest: allowAnyOrigin },
    async (request, reply) => {
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
    },
  );

  // Type-ahead (EUR-482): notable places and areas worldwide, and everything nearby.
  app.post<{ Body: SearchRequest }>(
    "/v1/search",
    { schema: { body: searchBody }, onRequest: allowAnyOrigin },
    async (request, reply) => {
      // What people type, and where they are, must not be kept anywhere along the way.
      reply.header("Cache-Control", "no-store");
      try {
        return { results: await search(pool, request.body) };
      } catch (error) {
        if (NO_DATA_CODES.has((error as { code?: string }).code ?? "")) {
          return reply.code(503).send({ error: "NoData", message: "no place data has been loaded yet" });
        }
        throw error;
      }
    },
  );

  // Endpoint B: everything in one ~1 km square, for apps that do not send a position.
  app.get<{ Params: { square: string }; Querystring: { page: number } }>(
    "/v1/squares/:square",
    { schema: { querystring: squareQuery }, onRequest: allowAnyOrigin },
    async (request, reply) => {
      try {
        const square = parseSquare(request.params.square);
        const body = await squareContents(pool, square, request.query.page, squarePageSize);
        reply.header("Cache-Control", SQUARE_CACHE);
        return body;
      } catch (error) {
        if (error instanceof SquareError) return reply.code(400).send({ error: error.code, message: error.message });
        if (NO_DATA_CODES.has((error as { code?: string }).code ?? "")) {
          return reply.code(503).send({ error: "NoData", message: "no place data has been loaded yet" });
        }
        throw error;
      }
    },
  );

  answerPreflight(app, "/v1/suggestions", "POST");
  answerPreflight(app, "/v1/search", "POST");
  answerPreflight(app, "/v1/squares/:square", "GET");

  registerAtgeoRoutes(app, pool, publicBaseUrl);
  if (internalToken) registerInternalRoutes(app, pool, internalToken);

  return app;
}
