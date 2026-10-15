// Routes for our own components, not for apps: the check-in listener reports check-ins,
// and admins hide or rename places. Every request needs the shared token.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "./db.ts";
import { deleteOverride, listOverrides, recordCheckins, setOverride, type CheckinEvent } from "./live.ts";

const URN = "^urn:atgeo:[^:]+:[^:]+:.+$";

const checkinBody = {
  type: "object",
  required: ["events"],
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        required: ["uri"],
        additionalProperties: false,
        properties: {
          uri: { type: "string", pattern: "^at://" },
          action: { type: "string", enum: ["create", "delete"], default: "create" },
          place: { type: "string", pattern: URN },
          createdAt: { type: "string", format: "date-time" },
          name: { type: "string", maxLength: 500 },
          lat: { type: "number", minimum: -90, maximum: 90 },
          lng: { type: "number", minimum: -180, maximum: 180 },
        },
        // A created check-in has to say where and when.
        if: { properties: { action: { const: "create" } } },
        then: { required: ["place", "createdAt"] },
      },
    },
  },
} as const;

const overrideBody = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    hidden: { type: "boolean" },
    name: { type: ["string", "null"], maxLength: 500 },
    note: { type: ["string", "null"], maxLength: 2000 },
  },
} as const;

const keyParams = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string", pattern: URN } },
} as const;

export function registerInternalRoutes(app: FastifyInstance, pool: Pool, token: string): void {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const given = Buffer.from(request.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };

  app.register(async (internal) => {
    internal.addHook("onRequest", authorize);

    internal.post<{ Body: { events: CheckinEvent[] } }>(
      "/internal/checkins",
      { schema: { body: checkinBody } },
      async (request) => recordCheckins(pool, request.body.events),
    );

    internal.get("/internal/overrides", async () => ({ overrides: await listOverrides(pool) }));

    internal.put<{ Params: { key: string }; Body: { hidden?: boolean; name?: string | null; note?: string | null } }>(
      "/internal/overrides/:key",
      { schema: { params: keyParams, body: overrideBody } },
      async (request) => setOverride(pool, request.params.key, request.body),
    );

    internal.delete<{ Params: { key: string } }>(
      "/internal/overrides/:key",
      { schema: { params: keyParams } },
      async (request, reply) =>
        (await deleteOverride(pool, request.params.key))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "NotFound" }),
    );
  });
}
