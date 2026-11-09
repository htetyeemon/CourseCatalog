import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorCode } from "../schemas/common.js";
import type { AppEnv } from "../types.js";
import { makeRequestId } from "./ids.js";

export function apiError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  const requestId = c.get("requestId") || makeRequestId();

  return c.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        requestId,
      },
    },
    status,
  );
}
