import { describe, expect, it, beforeAll, afterEach } from "vitest";
import app from "../src/index.js";
import { applyTestMigrations, resetTestState, env } from "./helpers/db.js";
import {
  mintToken,
  authHeaders,
  ROLES,
} from "./helpers/tokens.js";

type D1Database = typeof env.DB;

function request(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request("http://localhost" + input, init), env),
  );
}

async function exec(db: D1Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).bind(...params).run();
}

async function all<T = unknown>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results as T[];
}

async function insertCourse(
  db: D1Database,
  overrides: Partial<{
    id: string;
    code: string;
    title: string;
    description: string;
    department: string;
    level: string;
    credits: number;
    status: string;
    summary: string | null;
    tags: string | null;
    enrichment_source: string | null;
    published_at: string | null;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `crs_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();
  await exec(
    db,
    `INSERT INTO courses
       (id, code, title, description, department, level, credits, status, summary, tags, enrichment_source, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    overrides.code ?? `CS-${Math.floor(Math.random() * 9000) + 1000}`,
    overrides.title ?? "Test Course",
    overrides.description ?? "A test course description.",
    overrides.department ?? "Computer Science",
    overrides.level ?? "introductory",
    overrides.credits ?? 3,
    overrides.status ?? "published",
    overrides.summary ?? null,
    overrides.tags ?? null,
    overrides.enrichment_source ?? null,
    overrides.published_at ?? null,
    now,
    now,
  );
  return id;
}

async function insertInstructor(
  db: D1Database,
  overrides: Partial<{
    id: string;
    displayName: string;
    email: string;
    department: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `ins_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const now = new Date().toISOString();
  await exec(
    db,
    `INSERT INTO instructors (id, display_name, email, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    overrides.displayName ?? "Dr. Test",
    overrides.email ?? `${id}@example.edu`,
    overrides.department ?? "Computer Science",
    now,
    now,
  );
  return id;
}

async function linkInstructor(db: D1Database, courseId: string, instructorId: string) {
  await exec(
    db,
    `INSERT INTO course_instructors (course_id, instructor_id, position) VALUES (?, ?, 0)`,
    courseId,
    instructorId,
  );
}

async function insertPrerequisite(
  db: D1Database,
  courseId: string,
  prerequisiteCourseId: string,
  overrides: Partial<{ isRequired: boolean; minimumGrade: number | null }> = {},
) {
  await exec(
    db,
    `INSERT INTO prerequisites (course_id, prerequisite_course_id, is_required, minimum_grade, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    courseId,
    prerequisiteCourseId,
    overrides.isRequired ?? true ? 1 : 0,
    overrides.minimumGrade ?? null,
    new Date().toISOString(),
  );
}

function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}

describe("Course Catalog API — real D1", () => {
  beforeAll(async () => {
    await applyTestMigrations();
  });

  afterEach(async () => {
    await resetTestState();
  });

  // --- Case 1: GET /v1/courses returns only published courses for anonymous callers ---
  describe("GET /v1/courses", () => {
    it("returns only published courses by default (non-admin)", async () => {
      await insertCourse(env.DB, { code: "CS-101", status: "published" });
      await insertCourse(env.DB, { code: "CS-DRAFT", status: "draft" });
      await insertCourse(env.DB, { code: "CS-ARCH", status: "archived" });

      const res = await request("/v1/courses?limit=100");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ status: string }> };
      expect(body.data.length).toBe(1);
      expect(body.data[0]?.status).toBe("published");
    });

    it("returns draft courses to catalog_admin", async () => {
      await insertCourse(env.DB, { code: "CS-DRAFT", status: "draft" });

      const res = await request(
        "/v1/courses?status=draft",
        { headers: authHeaders(env, ROLES.CATALOG_ADMIN) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ status: string }> };
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.some((c) => c.status === "draft")).toBe(true);
    });

    // --- Case 12: Pagination caps and boundaries ---
    it("caps limit at 100 and paginates deterministically", async () => {
      for (let i = 0; i < 25; i += 1) {
        await insertCourse(env.DB, { code: `CS-${1000 + i}` });
      }

      const res = await request("/v1/courses?page=1&limit=10&sort=code&order=asc");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; page: number; limit: number; total: number };
      expect(body.total).toBe(25);
      expect(body.data.length).toBe(10);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(10);

      const res2 = await request("/v1/courses?page=3&limit=10&sort=code&order=asc");
      const body2 = (await res2.json()) as { data: unknown[] };
      expect(body2.data.length).toBe(5);
    });

    it("rejects limit above 100", async () => {
      const res = await request("/v1/courses?limit=101");
      expect(res.status).toBe(400);
    });
  });

  // --- Case 2: Search by keyword returns expected course (FTS) and survives special chars ---
  describe("GET /v1/courses?q=", () => {
    const pythonId = "crs_01J9ZK4Q7M2W8N5R3T6Y0B1PY1";

    beforeAll(async () => {
      await insertCourse(env.DB, {
        id: pythonId,
        code: "CS-101",
        title: "Introduction to Python",
        description: "Foundational course covering algorithms, data structures, and programming in Python.",
        department: "Computer Science",
      });
    });

    it("finds course by keyword via FTS5", async () => {
      const res = await request("/v1/courses?q=python&limit=100");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ code: string }> };
      expect(body.data.some((c) => c.code === "CS-101")).toBe(true);
    });

    it("survives quotes in search query", async () => {
      const res = await request(`/v1/courses?q=${encodeURIComponent('" OR 1=1 --')}&limit=100`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data.length).toBe(0);
    });

    it("survives asterisks in search query", async () => {
      const res = await request(`/v1/courses?q=${encodeURIComponent("Python*")}&limit=100`);
      expect(res.status).toBe(200);
    });
  });

  // --- Case 3: GET /v1/courses/{id} returns instructors and prerequisites; unknown id -> 404 ---
  describe("GET /v1/courses/{id}", () => {
    let courseId: string;

    beforeAll(async () => {
      courseId = await insertCourse(env.DB, {
        code: "CS-201",
        title: "Data Structures",
        description: "Core data structures and algorithms.",
      });
      const insId = await insertInstructor(env.DB, {
        displayName: "Dr. Ada",
        email: "ada@example.edu",
      });
      await linkInstructor(env.DB, courseId, insId);
      await insertPrerequisite(env.DB, courseId, "crs_prereq1", {
        isRequired: true,
        minimumGrade: 60,
      });
      await insertCourse(env.DB, { id: "crs_prereq1", code: "CS-101", status: "published" });
    });

    it("returns course with instructors and prerequisites", async () => {
      const res = await request(`/v1/courses/${courseId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ instructors: any[]; prerequisites: any[]; code: string }>;
      };
      const first = body.data[0];
      expect(first?.code).toBe("CS-201");
      expect(first?.instructors.length).toBe(1);
      expect(first?.instructors[0]?.displayName).toBe("Dr. Ada");
      expect(first?.prerequisites.length).toBe(1);
      expect(first?.prerequisites[0]?.courseId).toBe("crs_prereq1");
    });

    it("returns 404 error envelope for unknown id", async () => {
      const res = await request("/v1/courses/crs_DOESNOTEXIST00000000");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.requestId).toMatch(/^req_[A-Za-z0-9]{8,32}$/);
    });

    it("returns 400 for malformed id", async () => {
      const res = await request("/v1/courses/not-a-course");
      expect(res.status).toBe(400);
    });
  });

  // --- Case 4: POST /v1/courses authz ---
  describe("POST /v1/courses authorization", () => {
    const newCourse = {
      code: "CS-301",
      title: "New Course",
      description: "A newly created course.",
      department: "Computer Science",
      level: "introductory" as const,
      credits: 3,
    };

    it("returns 401 without a token", async () => {
      const res = await request("/v1/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonBody(newCourse),
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 with student role", async () => {
      const res = await request("/v1/courses", {
        method: "POST",
        headers: { ...authHeaders(env, ROLES.STUDENT), "Content-Type": "application/json" },
        body: jsonBody(newCourse),
      });
      expect(res.status).toBe(403);
    });

    it("returns 201 with catalog_admin role", async () => {
      const res = await request("/v1/courses", {
        method: "POST",
        headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN), "Content-Type": "application/json" },
        body: jsonBody(newCourse),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; code: string } };
      expect(body.data.code).toBe("CS-301");
      expect(body.data.id).toMatch(/^crs_/);
    });
  });

  // --- Case 5: POST /v1/courses invalid input returns 422 with field details ---
  describe("POST /v1/courses validation", () => {
    it("returns 422 with field-level details for invalid input", async () => {
      const res = await request("/v1/courses", {
        method: "POST",
        headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN), "Content-Type": "application/json" },
        body: jsonBody({
          code: "bad code",
          title: "",
          description: "x",
          department: "CS",
          level: "notalevel",
          credits: 99,
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details?: { fields: unknown[] } } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details?.fields.length).toBeGreaterThan(0);
    });
  });

  // --- Case 6: PUT prerequisites rejects cycle and self-reference ---
  describe("PUT /v1/courses/{id}/prerequisites", () => {
    let courseA: string;
    let courseB: string;

    beforeAll(async () => {
      courseA = await insertCourse(env.DB, { code: "CS-A", status: "published" });
      courseB = await insertCourse(env.DB, { code: "CS-B", status: "published" });
      // A depends on B
      await insertPrerequisite(env.DB, courseA, courseB);
    });

    it("rejects a prerequisite cycle (422 prerequisite_cycle)", async () => {
      // Adding B -> A would create a cycle A->B->A
      const res = await request(`/v1/courses/${courseB}/prerequisites`, {
        method: "PUT",
        headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN), "Content-Type": "application/json" },
        body: jsonBody({
          prerequisites: [{ courseId: courseA, required: true }],
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("prerequisite_cycle");
    });

    it("rejects a self-reference (422 prerequisite_self_reference)", async () => {
      const res = await request(`/v1/courses/${courseA}/prerequisites`, {
        method: "PUT",
        headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN), "Content-Type": "application/json" },
        body: jsonBody({
          prerequisites: [{ courseId: courseA, required: true }],
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("prerequisite_self_reference");
    });

    it("accepts valid prerequisites", async () => {
      const courseC = await insertCourse(env.DB, { code: "CS-C", status: "published" });
      const res = await request(`/v1/courses/${courseC}/prerequisites`, {
        method: "PUT",
        headers: { ...authHeaders(env, ROLES.CATALOG_ADMIN), "Content-Type": "application/json" },
        body: jsonBody({
          prerequisites: [{ courseId: courseA, required: true }],
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  // --- Case 7: POST /v1/prerequisites/check returns correct eligible/missing ---
  describe("POST /v1/prerequisites/check", () => {
    let courseId: string;
    let prereqId: string;

    beforeAll(async () => {
      courseId = await insertCourse(env.DB, { code: "CS-TARGET", status: "published" });
      prereqId = await insertCourse(env.DB, { code: "CS-PREQ", status: "published" });
      await insertPrerequisite(env.DB, courseId, prereqId, { isRequired: true });
    });

    it("returns eligible when prerequisites completed", async () => {
      const res = await request("/v1/prerequisites/check", {
        method: "POST",
        headers: { ...authHeaders(env, ROLES.STUDENT), "Content-Type": "application/json" },
        body: jsonBody({ courseId, completedCourseIds: [prereqId] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { eligible: boolean; missing: string[] };
      expect(body.eligible).toBe(true);
      expect(body.missing).toEqual([]);
    });

    it("returns not eligible with missing prerequisite", async () => {
      const res = await request("/v1/prerequisites/check", {
        method: "POST",
        headers: { ...authHeaders(env, ROLES.STUDENT), "Content-Type": "application/json" },
        body: jsonBody({ courseId, completedCourseIds: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { eligible: boolean; missing: string[] };
      expect(body.eligible).toBe(false);
      expect(body.missing).toContain(prereqId);
    });
  });
});
