import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const roles = new Set(["student", "instructor", "catalog_admin", "service"]);

async function loadDevVars() {
  try {
    const contents = await readFile(resolve(process.cwd(), ".dev.vars"), "utf8");
    const values = {};

    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);

      if (!match) {
        continue;
      }

      const [, key, rawValue] = match;
      values[key] = rawValue.replace(/^["']|["']$/g, "");
    }

    return values;
  } catch {
    return {};
  }
}

const { values } = parseArgs({
  options: {
    role: { type: "string", default: "student" },
    sub: { type: "string", default: "dev_user" },
    expires: { type: "string", default: "3600" },
    issuer: { type: "string" },
    audience: { type: "string" },
  },
  allowPositionals: false,
});

if (!roles.has(values.role)) {
  throw new Error(`Role must be one of: ${[...roles].join(", ")}.`);
}

const devVars = await loadDevVars();
const secret = process.env.JWT_SECRET || devVars.JWT_SECRET;

if (!secret) {
  throw new Error(
    "JWT_SECRET is required. Set it in .dev.vars or the environment.",
  );
}

const expiresIn = Number(values.expires);

if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
  throw new Error("--expires must be a positive integer number of seconds.");
}

const now = Math.floor(Date.now() / 1000);
const issuer =
  values.issuer ||
  process.env.JWT_ISSUER ||
  devVars.JWT_ISSUER ||
  "https://auth.course-catalog.dev";
const audience =
  values.audience ||
  process.env.JWT_AUDIENCE ||
  devVars.JWT_AUDIENCE ||
  "catalog-api";
const encode = (value) => Buffer.from(value).toString("base64url");
const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = encode(
  JSON.stringify({
    sub: values.sub,
    role: values.role,
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + expiresIn,
  }),
);
const signature = createHmac("sha256", secret)
  .update(`${header}.${payload}`)
  .digest("base64url");

console.log(`${header}.${payload}.${signature}`);
