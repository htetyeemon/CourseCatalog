import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorCode } from "../schemas/common.js";

export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}
