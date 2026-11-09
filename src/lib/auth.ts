import type { Context, MiddlewareHandler } from "hono";
import type { Role } from "../schemas/common.js";
import type { AppEnv, AuthContext } from "../types.js";
import { apiError } from "./errors.js";
import { JwtVerificationError, verifyJwt } from "./jwt.js";

export const READ_ROLES: Role[] = [
  "student",
  "instructor",
  "catalog_admin",
  "service",
];

export const WRITE_ROLES: Role[] = ["catalog_admin", "service"];

function unauthorized(c: Context<AppEnv>) {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
  return apiError(c, 401, "unauthorized", "A valid Bearer token is required.");
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");

  if (!header) {
    return unauthorized(c);
  }

  const [scheme, token, ...rest] = header.split(/\s+/);

  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
    return unauthorized(c);
  }

  let auth: AuthContext;

  try {
    auth = await verifyJwt(token, c.env);
  } catch (error) {
    if (
      error instanceof JwtVerificationError &&
      /unavailable|returned an invalid response|invalid claims/i.test(error.message)
    ) {
      return apiError(c, 503, "service_unavailable", "Student identity verification is temporarily unavailable.");
    }
    return unauthorized(c);
  }

  c.set("auth", auth);
  await next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");

    if (!auth) {
      return unauthorized(c);
    }

    if (!roles.includes(auth.role)) {
      return apiError(
        c,
        403,
        "forbidden",
        "You do not have permission to perform this operation.",
      );
    }

    await next();
  };
}

export function isCatalogAdmin(auth: AuthContext | null): boolean {
  return auth?.role === "catalog_admin" || auth?.role === "service";
}
