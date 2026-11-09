import type { MiddlewareHandler } from "hono";
import { RequestIdSchema } from "../schemas/common.js";
import type { AppEnv } from "../types.js";
import { makeRequestId } from "./ids.js";

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const parsed = incoming ? RequestIdSchema.safeParse(incoming) : null;
  const requestId = parsed?.success ? parsed.data : makeRequestId();

  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);

  await next();
};
