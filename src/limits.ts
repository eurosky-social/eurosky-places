import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Requests per client address and minute, for each public endpoint. Generous: an app's
// users are counted separately (each phone asks from its own address), and a type-ahead
// sends a request every few keystrokes. Mobile networks put many people behind one
// address, which is why these are well above what one person can type.
export interface RateLimits {
  suggestions: number;
  search: number;
  squares: number;
  getPlace: number;
}

export const PUBLIC_RATE_LIMITS: RateLimits = { suggestions: 300, search: 600, squares: 600, getPlace: 600 };

const ROUTES: Record<string, keyof RateLimits> = {
  "/v1/suggestions": "suggestions",
  "/v1/search": "search",
  "/v1/squares/:square": "squares",
  "/xrpc/org.atgeo.getPlace": "getPlace",
};

const WINDOW_MS = 60_000;

// Counts requests per address in one-minute windows, in memory only: an address is held
// until its minute is over and is never logged or stored. Preflight requests and
// /health are not counted.
export function registerRateLimits(app: FastifyInstance, limits: RateLimits, now: () => number = Date.now): void {
  const windows = new Map<string, { count: number; ends: number }>();
  let swept = now();

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const kind = ROUTES[request.routeOptions.url ?? ""];
    if (!kind || request.method === "OPTIONS") return;
    const t = now();
    if (t - swept > WINDOW_MS) {
      for (const [key, w] of windows) if (w.ends <= t) windows.delete(key);
      swept = t;
    }
    const key = `${kind} ${request.ip}`;
    let w = windows.get(key);
    if (!w || w.ends <= t) {
      w = { count: 0, ends: t + WINDOW_MS };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= limits[kind]) return;
    const seconds = Math.max(1, Math.ceil((w.ends - t) / 1000));
    // Every public endpoint allows any origin; a refusal must say so too, or a browser
    // shows the web app a network error instead of the 429.
    return reply
      .code(429)
      .header("Access-Control-Allow-Origin", "*")
      .header("Retry-After", String(seconds))
      .header("Cache-Control", "no-store")
      .send({
        error: "RateLimited",
        message: `more than ${limits[kind]} requests a minute from this address; try again in ${seconds} s`,
      });
  });
}
