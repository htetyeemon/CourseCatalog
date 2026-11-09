import type { z } from "zod";
import type {
  CourseDetailSchema,
  CourseListResponseSchema,
  CourseSchema,
  CreateCourseRequestSchema,
  ListCoursesQuerySchema,
  UpdateCourseRequestSchema,
} from "../schemas/course.js";
import { AppError } from "../lib/app-error.js";
import { toFtsMatchQuery } from "../lib/fts.js";
import { makeId } from "../lib/ids.js";
import {
  loadInstructorCourseIds,
  placeholders,
  toInstructor,
  toPrerequisite,
  type InstructorRow,
  type PrerequisiteRow,
} from "./shared.js";

type Course = z.infer<typeof CourseSchema>;
type CourseDetail = z.infer<typeof CourseDetailSchema>;
type CourseListResponse = z.infer<typeof CourseListResponseSchema>;
export type ListCoursesQuery = z.infer<typeof ListCoursesQuerySchema>;
export type CreateCourseInput = z.infer<typeof CreateCourseRequestSchema>;
export type UpdateCourseInput = z.infer<typeof UpdateCourseRequestSchema>;

interface CourseRow {
  id: string;
  code: string;
  title: string;
  description: string;
  department: string;
  level: Course["level"];
  credits: number;
  status: Course["status"];
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

const courseColumns = `c.id, c.code, c.title, c.description, c.department, c.level,
  c.credits, c.status, c.published_at, c.created_at, c.updated_at`;

const sortColumns: Record<ListCoursesQuery["sort"], string> = {
  code: "c.code",
  title: "c.title COLLATE NOCASE",
  createdAt: "c.created_at",
  updatedAt: "c.updated_at",
};

function toCourse(row: CourseRow, instructorIds: string[]): Course {
  const course: Course = {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    status: row.status,
    credits: row.credits,
    level: row.level,
    department: row.department,
    instructorIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.published_at !== null) {
    course.publishedAt = row.published_at;
  }

  return course;
}

async function loadCourseInstructorIds(
  db: D1Database,
  courseIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  if (courseIds.length === 0) {
    return result;
  }

  const rows = await db
    .prepare(
      `SELECT course_id, instructor_id
       FROM course_instructors
       WHERE course_id IN (${placeholders(courseIds.length)})
       ORDER BY course_id ASC, position ASC, instructor_id ASC`,
    )
    .bind(...courseIds)
    .all<{ course_id: string; instructor_id: string }>();

  for (const row of rows.results) {
    const instructorIds = result.get(row.course_id) ?? [];
    instructorIds.push(row.instructor_id);
    result.set(row.course_id, instructorIds);
  }

  return result;
}

export async function listCourses(
  db: D1Database,
  query: ListCoursesQuery,
  includeUnpublished: boolean,
): Promise<CourseListResponse> {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (query.status !== undefined) {
    conditions.push("c.status = ?");
    bindings.push(query.status);
  }

  if (!includeUnpublished) {
    conditions.push("c.status = 'published'");
  }

  if (query.department !== undefined) {
    conditions.push("c.department = ?");
    bindings.push(query.department);
  }

  if (query.level !== undefined) {
    conditions.push("c.level = ?");
    bindings.push(query.level);
  }

  if (query.instructorId !== undefined) {
    conditions.push(
      "EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ?)",
    );
    bindings.push(query.instructorId);
  }

  if (query.q !== undefined) {
    const ftsQuery = toFtsMatchQuery(query.q);

    if (ftsQuery !== null) {
      conditions.push(
        "c.rowid IN (SELECT rowid FROM courses_fts WHERE courses_fts MATCH ?)",
      );
      bindings.push(ftsQuery);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM courses c ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);

  if (total === 0) {
    return {
      data: [],
      page: query.page,
      limit: query.limit,
      total: 0,
    };
  }

  const offset = (query.page - 1) * query.limit;
  const direction = query.order === "desc" ? "DESC" : "ASC";
  const rows = await db
    .prepare(
      `SELECT ${courseColumns}
       FROM courses c
       ${where}
       ORDER BY ${sortColumns[query.sort]} ${direction}, c.id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, query.limit, offset)
    .all<CourseRow>();
  const instructorIdsByCourse = await loadCourseInstructorIds(
    db,
    rows.results.map((row) => row.id),
  );

  return {
    data: rows.results.map((row) =>
      toCourse(row, instructorIdsByCourse.get(row.id) ?? []),
    ),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getCourse(
  db: D1Database,
  courseId: string,
  includeUnpublished: boolean,
): Promise<CourseDetail | null> {
  const visibility = includeUnpublished ? "" : "AND c.status = 'published'";
  const row = await db
    .prepare(
      `SELECT ${courseColumns}
       FROM courses c
       WHERE c.id = ? ${visibility}`,
    )
    .bind(courseId)
    .first<CourseRow>();

  if (row === null) {
    return null;
  }

  const [instructorRows, prerequisiteRows] = await Promise.all([
    db
      .prepare(
        `SELECT i.id, i.display_name, i.email, i.department, i.bio, i.created_at, i.updated_at
         FROM course_instructors ci
         JOIN instructors i ON i.id = ci.instructor_id
         WHERE ci.course_id = ?
         ORDER BY ci.position ASC, i.display_name COLLATE NOCASE ASC, i.id ASC`,
      )
      .bind(courseId)
      .all<InstructorRow>(),
    db
      .prepare(
        `SELECT prerequisite_course_id, is_required, minimum_grade
         FROM prerequisites
         WHERE course_id = ?
         ORDER BY prerequisite_course_id ASC`,
      )
      .bind(courseId)
      .all<PrerequisiteRow>(),
  ]);

  const instructorIds = instructorRows.results.map((instructor) => instructor.id);
  const courseIdsByInstructor = await loadInstructorCourseIds(
    db,
    instructorIds,
    includeUnpublished,
  );
  const instructors = instructorRows.results.map((instructor) =>
    toInstructor(instructor, courseIdsByInstructor.get(instructor.id) ?? []),
  );
  const prerequisites = prerequisiteRows.results.map((prerequisite) =>
    toPrerequisite(prerequisite),
  );

  return {
    ...toCourse(row, instructorIds),
    instructors,
    prerequisites,
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function isUniqueConstraintError(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(error));
}

async function assertInstructorsExist(
  db: D1Database,
  instructorIds: string[],
): Promise<void> {
  const ids = uniqueIds(instructorIds);

  if (ids.length === 0) {
    return;
  }

  const rows = await db
    .prepare(
      `SELECT id FROM instructors WHERE id IN (${placeholders(ids.length)})`,
    )
    .bind(...ids)
    .all<{ id: string }>();
  const existing = new Set(rows.results.map((row) => row.id));
  const missingInstructorIds = ids.filter((id) => !existing.has(id));

  if (missingInstructorIds.length > 0) {
    throw new AppError(
      422,
      "validation_failed",
      "One or more instructors do not exist.",
      { missingInstructorIds },
    );
  }
}

async function assertCourseCodeAvailable(
  db: D1Database,
  code: string,
  excludeCourseId?: string,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT id FROM courses
       WHERE code = ? ${excludeCourseId === undefined ? "" : "AND id <> ?"}`,
    )
    .bind(...(excludeCourseId === undefined ? [code] : [code, excludeCourseId]))
    .first<{ id: string }>();

  if (row !== null) {
    throw new AppError(
      409,
      "conflict",
      "A course with this code already exists.",
      { code },
    );
  }
}

export async function createCourse(
  db: D1Database,
  input: CreateCourseInput,
): Promise<CourseDetail> {
  const instructorIds = uniqueIds(input.instructorIds ?? []);

  await assertInstructorsExist(db, instructorIds);
  await assertCourseCodeAvailable(db, input.code);

  const id = makeId("crs");
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO courses
           (id, code, title, description, department, level, credits, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(
        id,
        input.code,
        input.title,
        input.description,
        input.department,
        input.level,
        input.credits,
        now,
        now,
      ),
    ...instructorIds.map((instructorId, position) =>
      db
        .prepare(
          `INSERT INTO course_instructors (course_id, instructor_id, position)
           VALUES (?, ?, ?)`,
        )
        .bind(id, instructorId, position),
    ),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError(
        409,
        "conflict",
        "A course with this code already exists.",
        { code: input.code },
      );
    }

    throw error;
  }

  const course = await getCourse(db, id, true);

  if (course === null) {
    throw new Error("Created course could not be loaded.");
  }

  return course;
}

export async function updateCourse(
  db: D1Database,
  courseId: string,
  input: UpdateCourseInput,
): Promise<CourseDetail> {
  const existing = await db
    .prepare("SELECT id FROM courses WHERE id = ?")
    .bind(courseId)
    .first<{ id: string }>();

  if (existing === null) {
    throw new AppError(404, "not_found", "The requested resource was not found.");
  }

  const instructorIds =
    input.instructorIds === undefined ? undefined : uniqueIds(input.instructorIds);

  if (instructorIds !== undefined) {
    await assertInstructorsExist(db, instructorIds);
  }

  if (input.code !== undefined) {
    await assertCourseCodeAvailable(db, input.code, courseId);
  }

  const now = new Date().toISOString();
  const assignments: string[] = [];
  const bindings: (string | number)[] = [];

  if (input.code !== undefined) {
    assignments.push("code = ?");
    bindings.push(input.code);
  }

  if (input.title !== undefined) {
    assignments.push("title = ?");
    bindings.push(input.title);
  }

  if (input.description !== undefined) {
    assignments.push("description = ?");
    bindings.push(input.description);
  }

  if (input.credits !== undefined) {
    assignments.push("credits = ?");
    bindings.push(input.credits);
  }

  if (input.level !== undefined) {
    assignments.push("level = ?");
    bindings.push(input.level);
  }

  if (input.department !== undefined) {
    assignments.push("department = ?");
    bindings.push(input.department);
  }

  assignments.push("updated_at = ?");
  bindings.push(now);

  const statements = [
    db
      .prepare(`UPDATE courses SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...bindings, courseId),
  ];

  if (instructorIds !== undefined) {
    statements.push(
      db
        .prepare("DELETE FROM course_instructors WHERE course_id = ?")
        .bind(courseId),
      ...instructorIds.map((instructorId, position) =>
        db
          .prepare(
            `INSERT INTO course_instructors (course_id, instructor_id, position)
             VALUES (?, ?, ?)`,
          )
          .bind(courseId, instructorId, position),
      ),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError(
        409,
        "conflict",
        "A course with this code already exists.",
        { code: input.code },
      );
    }

    throw error;
  }

  const course = await getCourse(db, courseId, true);

  if (course === null) {
    throw new AppError(404, "not_found", "The requested resource was not found.");
  }

  return course;
}
