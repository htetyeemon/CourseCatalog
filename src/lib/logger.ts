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

const sensitiveKey = /authorization|cookie|secret|token|jwt|password/i;
// Bearer tokens / compact JWTs that end up inside free-text fields.
const tokenPattern = /(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(tokenPattern, "[redacted]");
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      redacted[key] = sensitiveKey.test(key) ? "[redacted]" : redact(val);
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
