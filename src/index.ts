import { Hono } from "hono";

function makeRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `req_${hex}`;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/health", async (c) => {
  const requestId = makeRequestId();
  let databaseHealthy = true;

  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
  } catch {
    databaseHealthy = false;
  }

  const aiHealthy = Boolean(c.env.AI);

  if (!databaseHealthy || !aiHealthy) {
    return c.json(
      {
        error: {
          code: "service_unavailable" as const,
          message: "One or more dependencies are unavailable.",
          requestId,
        },
      },
      503,
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

app.notFound((c) => {
  const pathname = new URL(c.req.url).pathname;

  if (pathname.startsWith("/v1/")) {
    return c.json(
      {
        error: {
          code: "not_found" as const,
          message: "The requested resource was not found.",
          requestId: makeRequestId(),
        },
      },
      404,
    );
  }

  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error(error);

  return c.json(
    {
      error: {
        code: "internal_error" as const,
        message: "An unexpected error occurred.",
        requestId: makeRequestId(),
      },
    },
    500,
  );
});

export default app;
