import { Hono } from "hono";
import { apiError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const healthRoute = new Hono<AppEnv>();

healthRoute.get("/", async (c) => {
  let databaseHealthy = true;

  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
  } catch {
    databaseHealthy = false;
  }

  const aiHealthy = Boolean(c.env.AI);

  c.header("Cache-Control", "no-store");

  if (!databaseHealthy || !aiHealthy) {
    return apiError(
      c,
      503,
      "service_unavailable",
      "One or more dependencies are unavailable.",
    );
  }

  return c.json(
    {
      status: "ok" as const,
      version: c.env.APP_VERSION,
      timestamp: new Date().toISOString(),
      checks: {
        database: "ok" as const,
        ai: "ok" as const,
      },
    },
    200,
  );
});
