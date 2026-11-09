import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

export interface LogRecord {
  level: string;
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status?: number;
  latencyMs?: number;
  role?: string;
  error?: string;
  message: string;
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Never log Authorization headers or JWT fragments.
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization") ||
        lower.includes("cookie") ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("jwt") ||
        lower.includes("password")
      ) {
        redacted[key] = "[redacted]";
      } else {
        redacted[key] = redact(val);
      }
    }
    return redacted;
  }

  return value;
}

export function structuredLog(record: LogRecord): void {
  const sanitized = redact(record);
  console.log(JSON.stringify(sanitized));
}

export const loggingMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  const requestId = c.get("requestId") || crypto.randomUUID();

  await next();

  const latencyMs = Date.now() - start;
  const status = c.res.status;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

  structuredLog({
    level,
    timestamp: new Date().toISOString(),
    requestId,
    method: c.req.method,
    path: c.req.path,
    status,
    latencyMs,
    message: `${c.req.method} ${c.req.path} ${status}`,
  });
};
