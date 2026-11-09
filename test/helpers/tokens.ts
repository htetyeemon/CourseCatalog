import { createHmac } from "node:crypto";

const JWT_ISSUER = "https://auth.course-catalog.dev";
const JWT_AUDIENCE = "catalog-api";

export function mintToken(
  env: { JWT_SECRET: string },
  overrides: {
    sub?: string;
    role?: string;
    iss?: string;
    aud?: string;
    exp?: number;
    iat?: number;
  } = {},
): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured in the test environment.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64Url(
    JSON.stringify({
      sub: overrides.sub ?? "stu_000000000000000000000001",
      role: overrides.role ?? "student",
      iss: overrides.iss ?? JWT_ISSUER,
      aud: overrides.aud ?? JWT_AUDIENCE,
      iat: overrides.iat ?? now,
      exp: overrides.exp ?? now + 3600,
    }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}

function b64Url(value: string): string {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const ROLES = {
  STUDENT: "student",
  INSTRUCTOR: "instructor",
  CATALOG_ADMIN: "catalog_admin",
  SERVICE: "service",
} as const;

export function authHeaders(
  env: { JWT_SECRET: string },
  role: string,
  overrides: {
    sub?: string;
    iss?: string;
    aud?: string;
    exp?: number;
    iat?: number;
  } = {},
): { Authorization: string } {
  return { Authorization: `Bearer ${mintToken(env, { role, ...overrides })}` };
}
