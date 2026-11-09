import { z } from "zod";
import { RoleSchema } from "../schemas/common.js";
import type { AuthContext } from "../types.js";

const JwtHeaderSchema = z
  .object({
    alg: z.string().min(1),
    typ: z.string().optional(),
    kid: z.string().optional(),
  })
  .passthrough();

const JwtClaimsSchema = z
  .object({
    sub: z.string().min(1),
    role: RoleSchema,
    iss: z.string().min(1),
    exp: z.number().int(),
    nbf: z.number().int().optional(),
    iat: z.number().int().optional(),
    aud: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

type JwtHeader = z.infer<typeof JwtHeaderSchema>;
type JwtClaims = z.infer<typeof JwtClaimsSchema>;

interface ParsedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  signature: Uint8Array;
  signingInput: Uint8Array;
}

type JwtVerifier = (token: ParsedJwt, env: Env) => Promise<JwtClaims>;

const clockSkewSeconds = 60;
const defaultIssuer = "https://auth.course-catalog.dev";
const defaultAudience = "catalog-api";

export class JwtVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtVerificationError";
  }
}

function decodeSegment(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(segment)) {
    throw new JwtVerificationError("JWT segment is not valid base64url.");
  }

  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;

  try {
    const binary = atob(base64.padEnd(base64.length + padding, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new JwtVerificationError("JWT segment is not valid base64url.");
  }
}

function decodeJsonSegment<T>(segment: string, schema: z.ZodType<T>): T {
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
  } catch {
    throw new JwtVerificationError("JWT segment is not valid JSON.");
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new JwtVerificationError("JWT segment has an invalid shape.");
  }

  return parsed.data;
}

function parseToken(token: string): ParsedJwt {
  const segments = token.split(".");

  if (segments.length !== 3) {
    throw new JwtVerificationError("JWT must have three segments.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments as [
    string,
    string,
    string,
  ];
  const header = decodeJsonSegment(encodedHeader, JwtHeaderSchema);

  if (header.typ !== undefined && header.typ.toUpperCase() !== "JWT") {
    throw new JwtVerificationError("JWT type must be JWT.");
  }

  return {
    header,
    claims: decodeJsonSegment(encodedPayload, JwtClaimsSchema),
    signature: decodeSegment(encodedSignature),
    signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  };
}

async function verifyHs256(token: ParsedJwt, env: Env): Promise<JwtClaims> {
  const secret = env.JWT_SECRET;

  if (!secret) {
    throw new JwtVerificationError("JWT_SECRET is not configured.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    token.signature,
    token.signingInput,
  );

  if (!valid) {
    throw new JwtVerificationError("JWT signature is invalid.");
  }

  return token.claims;
}

const verifiers: Record<string, JwtVerifier> = {
  HS256: verifyHs256,
};

function validateClaims(claims: JwtClaims, env: Env): AuthContext {
  const now = Math.floor(Date.now() / 1000);

  if (claims.exp < now - clockSkewSeconds) {
    throw new JwtVerificationError("JWT has expired.");
  }

  if (claims.nbf !== undefined && claims.nbf > now + clockSkewSeconds) {
    throw new JwtVerificationError("JWT is not valid yet.");
  }

  if (claims.iss !== (env.JWT_ISSUER || defaultIssuer)) {
    throw new JwtVerificationError("JWT issuer is not trusted.");
  }

  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    if (!audiences.includes(env.JWT_AUDIENCE || defaultAudience)) {
      throw new JwtVerificationError("JWT audience is not accepted.");
    }
  }

  return {
    sub: claims.sub,
    role: claims.role,
  };
}

export async function verifyJwt(token: string, env: Env): Promise<AuthContext> {
  // Student Identity owns student credentials and token signing. Ask its verifier
  // rather than trusting claims decoded from the bearer token locally.
  let identityResponse: Response;
  try {
    identityResponse = await fetch("https://student-identity.onrender.com/tokens/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new JwtVerificationError("Student Identity verification is unavailable.");
  }

  if (!identityResponse.ok) {
    throw new JwtVerificationError("Student Identity verification is unavailable.");
  }

  let identity: unknown;
  try {
    identity = await identityResponse.json();
  } catch {
    throw new JwtVerificationError("Student Identity returned an invalid response.");
  }

  if (
    typeof identity !== "object" || identity === null ||
    !("valid" in identity) || typeof identity.valid !== "boolean"
  ) {
    throw new JwtVerificationError("Student Identity returned an invalid response.");
  }

  if (
    identity.valid === true
  ) {
    const claims = identity as { sub?: unknown; role?: unknown; expiresAt?: unknown };
    const expiresAt = typeof claims.expiresAt === "string" ? Date.parse(claims.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || typeof claims.sub !== "string" || !claims.sub) {
      throw new JwtVerificationError("Student Identity returned invalid claims.");
    }
    if (claims.role === "student") return { sub: claims.sub, role: "student" };
    if (claims.role === "instructor") return { sub: claims.sub, role: "instructor" };
    throw new JwtVerificationError("This identity role cannot access the Course Catalog.");
  }

  if ("reason" in identity && identity.reason === "suspended") {
    throw new JwtVerificationError("This identity is suspended.");
  }

  // Preserve the existing catalog-issued token path for catalog administrators,
  // services, local development, and existing integrations.
  const parsed = parseToken(token);
  const verifier = Object.hasOwn(verifiers, parsed.header.alg)
    ? verifiers[parsed.header.alg]
    : undefined;

  if (!verifier) {
    throw new JwtVerificationError("JWT algorithm is not supported.");
  }

  return validateClaims(await verifier(parsed, env), env);
}
