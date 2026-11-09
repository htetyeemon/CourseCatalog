import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyTestMigrations, resetTestState, env } from "./helpers/db.js";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import YAML from "yaml";
import app from "../src/index.js";
import openapiSource from "../openapi.yaml?raw";
import { mintToken, authHeaders, ROLES } from "./helpers/tokens.js";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

// Load the OpenAPI document and compile schemas for key responses.
const document = YAML.parse(openapiSource as string) as Record<string, unknown>;
const validators = new Map<string, ValidateFunction>();

function request(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request("http://localhost" + input, init), env),
  );
}

async function insertCourse(
  overrides: Partial<{
    id: string;
    code: string;
    title: string;
    description: string;
    department: string;
    level: string;
    credits: number;
    status: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `crs_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO courses
       (id, code, title, description, department, level, credits, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    overrides.code ?? `CS-${Math.floor(Math.random() * 9000) + 1000}`,
    overrides.title ?? "Conformance Test Course",
    overrides.description ?? "A course for conformance testing.",
    overrides.department ?? "Computer Science",
    overrides.level ?? "introductory",
    overrides.credits ?? 3,
    overrides.status ?? "published",
    now,
    now,
  )
  .run();
  return id;
}

async function insertInstructor(
  overrides: Partial<{ id: string; displayName: string; email: string }> = {},
): Promise<string> {
  const id = overrides.id ?? `ins_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO instructors (id, display_name, email, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, overrides.displayName ?? "Dr. CT", `${id}@example.edu`, "Computer Science", now, now)
  .run();
  return id;
}

async function linkInstructor(courseId: string, instructorId: string) {
  await env.DB.prepare(
    `INSERT INTO course_instructors (course_id, instructor_id, position) VALUES (?, ?, 0)`,
  ).bind(courseId, instructorId)
  .run();
}

function validateAgainstSchema(
  schemaName: string,
  value: unknown,
): { valid: boolean; errors: string[] } {
  const components = (document.components as Record<string, unknown> | undefined)?.schemas as
    | Record<string, unknown>
    | undefined;
  const schema = components?.[schemaName];
  if (!schema) {
    return { valid: false, errors: [`Schema ${schemaName} not found in openapi.yaml`] };
  }
  // Component schemas reference each other through "#/components/schemas/...", so the
  // validator is compiled from a wrapper that carries the whole components tree.
  let validate = validators.get(schemaName);
  if (!validate) {
    validate = ajv.compile({
      $ref: `#/components/schemas/${schemaName}`,
      components: { schemas: components },
    });
    validators.set(schemaName, validate);
  }
  const valid = validate(value);
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath ?? ""} ${e.message ?? ""}`);
  return { valid, errors };
}

describe("Contract conformance (responses match openapi.yaml)", () => {
  let adminToken: string;
  let studentToken: string;
  let courseId: string;

  beforeEach(async () => {
    await applyTestMigrations();

    adminToken = mintToken(env, { role: ROLES.CATALOG_ADMIN });
    studentToken = mintToken(env, { role: ROLES.STUDENT });

    courseId = await insertCourse({ code: "CS-901", status: "published" });
    const insId = await insertInstructor({ displayName: "Dr. CT" });
    await linkInstructor(courseId, insId);
  });

  afterEach(async () => {
    await resetTestState();
  });

  it("GET /v1/health returns the HealthResponse schema", async () => {
    const res = await request("/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("HealthResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
  });

  it("GET /v1/courses returns CourseListResponse schema for published courses", async () => {
    const res = await request(
      "/v1/courses?limit=100",
      { headers: authHeaders(env, ROLES.STUDENT) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("CourseListResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(
      body.data.every((c: { status: string }) => c.status === "published"),
    ).toBe(true);
  });

  it("GET /v1/courses/{id} returns CourseResponse schema with instructors and prerequisites", async () => {
    const res = await request(
      `/v1/courses/${courseId}`,
      { headers: authHeaders(env, ROLES.STUDENT) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("CourseResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(Array.isArray(body.data.instructors)).toBe(true);
    expect(Array.isArray(body.data.prerequisites)).toBe(true);
  });

  it("GET /v1/courses/{id} unknown returns NotFound error envelope", async () => {
    const res = await request(
      "/v1/courses/crs_DOESNOTEXIST00000000",
      { headers: authHeaders(env, ROLES.STUDENT) },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("ErrorResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toMatch(/^req_[A-Za-z0-9]{8,32}$/);
  });

  it("POST /v1/courses without token returns 401 Unauthorized error envelope", async () => {
    const res = await request("/v1/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "CS-902",
        title: "Unauthorized Course",
        description: "Should not be created.",
        credits: 3,
        level: "introductory",
        department: "Computer Science",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("ErrorResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(body.error.code).toBe("unauthorized");
  });

  it("POST /v1/courses with student role returns 403 Forbidden error envelope", async () => {
    const res = await request("/v1/courses", {
      method: "POST",
      headers: {
        ...authHeaders(env, ROLES.STUDENT),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "CS-902",
        title: "Forbidden Course",
        description: "Should not be created.",
        credits: 3,
        level: "introductory",
        department: "Computer Science",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("ErrorResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(body.error.code).toBe("forbidden");
  });

  it("POST /v1/courses with catalog_admin returns 201 CourseResponse schema", async () => {
    const res = await request("/v1/courses", {
      method: "POST",
      headers: {
        ...authHeaders(env, ROLES.CATALOG_ADMIN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "CS-902",
        title: "Admin Created Course",
        description: "Created via conformance test.",
        credits: 4,
        level: "intermediate",
        department: "Computer Science",
        instructorIds: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("CourseResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(body.data.code).toBe("CS-902");
  });

  it("POST /v1/courses invalid input returns 422 validation_failed envelope", async () => {
    const res = await request("/v1/courses", {
      method: "POST",
      headers: {
        ...authHeaders(env, ROLES.CATALOG_ADMIN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "bad code",
        title: "",
        description: "x",
        department: "CS",
        level: "notalevel",
        credits: 99,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("ErrorResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details?.fields.length).toBeGreaterThan(0);
  });

  it("POST /v1/prerequisites/check returns PrerequisiteCheckResponse schema", async () => {
    const prereqId = await insertCourse({ code: "CS-950", status: "published" });

    const res = await request("/v1/prerequisites/check", {
      method: "POST",
      headers: {
        ...authHeaders(env, ROLES.STUDENT),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ courseId, completedCourseIds: [prereqId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const result = validateAgainstSchema("PrerequisiteCheckResponse", body);
    expect(result.valid, result.errors.join("; ")).toBe(true);
    expect(typeof body.eligible).toBe("boolean");
    expect(Array.isArray(body.missing)).toBe(true);
  });

  it("Every /v1 path documented in openapi.yaml is mounted on the worker", async () => {
    const paths = Object.keys(document.paths ?? {}) as string[];
    for (const path of paths) {
      expect(path.startsWith("/v1/"), path).toBe(true);
    }
    // Key paths should all be present.
    const expected = [
      "/v1/courses",
      "/v1/courses/{courseId}",
      "/v1/courses/{courseId}/publish",
      "/v1/courses/{courseId}/prerequisites",
      "/v1/prerequisites/check",
      "/v1/webhooks/subscriptions",
      "/v1/webhooks/deliveries",
      "/v1/health",
    ];
    for (const expectedPath of expected) {
      expect(paths).toContain(expectedPath);
    }
  });

  it("Rate limit headers are present on /v1 responses", async () => {
    const res = await request(
      "/v1/courses?limit=5",
      { headers: authHeaders(env, ROLES.STUDENT) },
    );
    expect(res.headers.get("ratelimit-limit")).toBeDefined();
    expect(res.headers.get("ratelimit-remaining")).toBeDefined();
    expect(res.headers.get("ratelimit-reset")).toBeDefined();
  });
});
