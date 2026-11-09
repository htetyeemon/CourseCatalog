import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import app from "../src/index.js";
import { applyTestMigrations, resetTestState, env } from "./helpers/db.js";
import { mintToken, authHeaders, ROLES } from "./helpers/tokens.js";

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
    overrides.title ?? "Test Course",
    overrides.description ?? "A test course description.",
    overrides.department ?? "Computer Science",
    overrides.level ?? "introductory",
    overrides.credits ?? 3,
    overrides.status ?? "draft",
    now,
    now,
  );
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
  ).bind(id, overrides.displayName ?? "Dr. Test", overrides.email ?? `${id}@example.edu`, "Computer Science", now, now);
  return id;
}

async function linkInstructor(courseId: string, instructorId: string) {
  await env.DB.prepare(
    `INSERT INTO course_instructors (course_id, instructor_id, position) VALUES (?, ?, 0)`,
  ).bind(courseId, instructorId);
}

function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}

// Mock Workers AI run. Workers AI `run(model, input)` returns { response: string }.
function mockAiRun(result: { response: string } | Error): ReturnType<typeof vi.fn> {
  const run = vi.fn();
  if (result instanceof Error) {
    run.mockRejectedValue(result);
  } else {
    run.mockResolvedValue(result);
  }
  (env as unknown as Record<string, unknown>).AI = { run };
  return run;
}

describe("Course Catalog — publish & enrichment", () => {
  beforeAll(async () => {
    const { readD1Migrations } = await import("@cloudflare/vitest-plugin");
    const { applyD1Migrations } = await import("cloudflare:test");
    const migrations = await readD1Migrations("./migrations");
    await applyD1Migrations(env.DB, migrations);
  });

  afterEach(async () => {
    await resetTestState();
    vi.restoreAllMocks();
  });

  // --- Case 8: AI stubbed to fail uses fallback and still succeeds ---
  it("publishes with fallback enrichment when AI fails", async () => {
    mockAiRun(new Error("Workers AI unavailable"));

    const courseId = await insertCourse({ status: "draft" });
    const insId = await insertInstructor();
    await linkInstructor(courseId, insId);

    const res = await request(`/v1/courses/${courseId}/publish`, {
      method: "POST",
      headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enrichment_source: string } };
    expect(body.data.enrichment_source).toBe("fallback");
  });

  // --- Case 9: AI returns valid JSON uses "ai" source and filters nonexistent codes ---
  it("publishes with AI enrichment when AI succeeds", async () => {
    const validId = await insertCourse({ code: "CS-VALID", status: "published" });
    const courseId = await insertCourse({ status: "draft" });
    const insId = await insertInstructor();
    await linkInstructor(courseId, insId);

    mockAiRun({
      response: JSON.stringify({
        summary: "A great course about testing.",
        tags: ["testing", "vitest"],
        suggestedPrerequisites: [validId, "crs_DOESNOTEXIST00000000"],
      }),
    });

    const res = await request(`/v1/courses/${courseId}/publish`, {
      method: "POST",
      headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enrichment_source: string } };
    expect(body.data.enrichment_source).toBe("ai");
  });
});
