import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import { apiError } from "./errors.js";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000, // 1 minute
  maxRequests: 100,
};

// In-memory fixed-window counters keyed by `${ip}:${path}`.
// Resets are best-effort; entries are evicted when they fall outside the window.
const windows = new Map<string, WindowEntry>();

function nowMs(): number {
  return Date.now();
}

function pruneStaleWindows(): void {
  const now = nowMs();
  for (const [key, entry] of windows.entries()) {
    if (entry.resetAt <= now) {
      windows.delete(key);
    }
  }
}

export function rateLimitMiddleware(
  config: RateLimitConfig = DEFAULT_CONFIG,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    pruneStaleWindows();

    // Cloudflare sets CF-Connecting-IP from the real client connection; clients can
    // forge X-Forwarded-For, so it is only a fallback for non-Cloudflare environments.
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    const path = c.req.path;
    const key = `${ip}:${path}`;

    let entry = windows.get(key);

    if (!entry || entry.resetAt <= nowMs()) {
      entry = { count: 1, resetAt: nowMs() + config.windowMs };
      windows.set(key, entry);
    } else {
      entry.count += 1;
      windows.set(key, entry);
    }

    const remaining = Math.max(0, config.maxRequests - entry.count);

    c.header("RateLimit-Limit", String(config.maxRequests));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(Math.floor(entry.resetAt / 1000)));

    if (entry.count > config.maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - nowMs()) / 1000);
      c.header("Retry-After", String(Math.max(1, retryAfter)));
      return apiError(
        c,
        429,
        "rate_limited",
        "Too many requests. Please slow down and try again later.",
        { retryAfter: Math.max(1, retryAfter) },
      );
    }

    await next();
  };
}

export { type RateLimitConfig };
