import { Hono } from "hono";
import { cors } from "hono/cors";
import openapiDocument from "./openapi.json";
import { authMiddleware } from "./lib/auth.js";
import { AppError } from "./lib/app-error.js";
import { apiError } from "./lib/errors.js";
import { requestIdMiddleware } from "./lib/request-id.js";
import { coursesRoute } from "./routes/courses.js";
import { authRoute } from "./routes/auth.js";
import { healthRoute } from "./routes/health.js";
import { instructorsRoute } from "./routes/instructors.js";
import {
  coursePrerequisitesRoute,
  prerequisitesRoute,
} from "./routes/prerequisites.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { processDueDeliveries } from "./lib/delivery.js";
import { loggingMiddleware } from "./lib/logger.js";
import { rateLimitMiddleware } from "./lib/rate-limit.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

app.use("*", requestIdMiddleware);
app.use("*", loggingMiddleware);
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    exposeHeaders: ["Location", "X-Request-Id"],
    maxAge: 86_400,
  }),
);
app.use("/v1/auth/*", rateLimitMiddleware({ windowMs: 60_000, maxRequests: 10 }));
app.use("/v1/*", rateLimitMiddleware());
app.use("/v1/*", async (c, next) => {
  if (
    c.req.path === "/v1/health" ||
    c.req.path === "/v1/auth/login" ||
    c.req.path === "/v1/auth/signup"
  ) {
    await next();
    return;
  }

  return authMiddleware(c, next);
});

app.route("/v1/health", healthRoute);
app.route("/v1/auth", authRoute);
app.route("/v1/courses", coursesRoute);
app.route("/v1/courses", coursePrerequisitesRoute);
app.route("/v1/instructors", instructorsRoute);
app.route("/v1/prerequisites", prerequisitesRoute);
app.route("/v1/webhooks", webhooksRoute);

app.get("/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(openapiDocument);
});

app.notFound((c) => {
  const pathname = new URL(c.req.url).pathname;

  if (pathname.startsWith("/v1/")) {
    return apiError(c, 404, "not_found", "The requested resource was not found.");
  }

  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof AppError) {
    return apiError(c, error.status, error.code, error.message, error.details);
  }

  console.error(error);
  return apiError(c, 500, "internal_error", "An unexpected error occurred.");
});

const handler = {
  fetch: app.fetch,
  // Cron Triggers (wrangler.jsonc `triggers.crons`) invoke the `scheduled` handler.
  scheduled(
    _controller: ScheduledController,
    env: AppEnv["Bindings"],
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(processDueDeliveries(env));
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

export default handler;
