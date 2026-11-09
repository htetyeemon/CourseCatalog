import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "../lib/app-error.js";
import { verifyJwt } from "../lib/jwt.js";
import { parseJsonBody } from "../lib/validation.js";
import type { AppEnv } from "../types.js";

const LoginSchema = z.object({
  studentId: z.string().regex(/^\d{10}$/, "Student ID must be 10 digits."),
  password: z.string().min(1).max(1024),
}).strict();
const SignupSchema = z.object({
  studentId: z.string().regex(/^\d{10}$/, "Student ID must be 10 digits."),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.email(),
  faculty: z.string().trim().max(120).optional().default(""),
  password: z.string().min(8).max(1024),
}).strict();

const IDENTITY_URL = "https://student-identity.onrender.com";
export const authRoute = new Hono<AppEnv>();

async function createIdentitySession(token: string, c: Context<AppEnv>) {
  let auth;
  try {
    auth = await verifyJwt(token, c.env);
  } catch (error) {
    if (error instanceof Error && /unavailable|returned an invalid response|invalid claims/i.test(error.message)) {
      throw new AppError(503, "service_unavailable", "Student sign-in is temporarily unavailable.");
    }
    if (error instanceof Error && error.message.includes("role cannot access")) {
      throw new AppError(403, "forbidden", "Only student accounts can sign in to the Course Catalog.");
    }
    throw new AppError(401, "unauthorized", "This account cannot sign in to the Course Catalog.");
  }
  if (auth.role !== "student") {
    throw new AppError(403, "forbidden", "Only student accounts can sign in to the Course Catalog.");
  }
  return { data: { token, subject: auth.sub, role: auth.role } };
}

async function postIdentityAuth(path: "login" | "signup", body: unknown) {
  let upstream: Response;
  try {
    upstream = await fetch(`${IDENTITY_URL}/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError(503, "service_unavailable", "Student Identity is temporarily unavailable.");
  }

  let result: unknown;
  try {
    result = await upstream.json();
  } catch {
    throw new AppError(503, "service_unavailable", "Student Identity returned an invalid response.");
  }
  if (!upstream.ok) {
    if (upstream.status >= 500) {
      throw new AppError(503, "service_unavailable", "Student Identity is temporarily unavailable.");
    }
    if (upstream.status === 429) {
      throw new AppError(429, "rate_limited", "Too many account requests. Please try again later.");
    }
    if (path === "login") {
      throw new AppError(401, "unauthorized", "Student ID or password is incorrect.");
    }
    throw new AppError(422, "validation_failed", "Student Identity could not create or authenticate this account.");
  }

  const token = typeof result === "object" && result !== null && "token" in result && typeof result.token === "string"
    ? result.token
    : null;
  if (!token) {
    throw new AppError(503, "service_unavailable", "Student Identity returned an invalid response.");
  }
  return token;
}

authRoute.post("/login", async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = await parseJsonBody(c, LoginSchema);
  if (!parsed.success) return parsed.response;

  const token = await postIdentityAuth("login", parsed.data);
  return c.json(await createIdentitySession(token, c));
});

authRoute.post("/signup", async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = await parseJsonBody(c, SignupSchema);
  if (!parsed.success) return parsed.response;
  const token = await postIdentityAuth("signup", parsed.data);
  return c.json(await createIdentitySession(token, c));
});
