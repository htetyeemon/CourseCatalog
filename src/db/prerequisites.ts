import type { z } from "zod";
import { AppError } from "../lib/app-error.js";
import type {
  PrerequisiteCheckResponseSchema,
  PrerequisiteRuleSchema,
  PrerequisiteSetSchema,
} from "../schemas/prerequisite.js";
import { placeholders } from "./shared.js";

type PrerequisiteCheckResponse = z.infer<typeof PrerequisiteCheckResponseSchema>;
type PrerequisiteRule = z.infer<typeof PrerequisiteRuleSchema>;
type PrerequisiteSet = z.infer<typeof PrerequisiteSetSchema>;

interface CourseIdRow {
  id: string;
}

interface CourseStatusRow {
  id: string;
  status: string;
}

interface PrerequisiteEdgeRow {
  course_id: string;
  prerequisite_course_id: string;
}

async function findCourseStatus(
  db: D1Database,
  courseId: string,
): Promise<CourseStatusRow | null> {
  return db
    .prepare("SELECT id, status FROM courses WHERE id = ?")
    .bind(courseId)
    .first<CourseStatusRow>();
}

async function findMissingCourseIds(
  db: D1Database,
  courseIds: string[],
): Promise<string[]> {
  if (courseIds.length === 0) {
    return [];
  }

  const rows = await db
    .prepare(
      `SELECT id FROM courses WHERE id IN (${placeholders(courseIds.length)})`,
    )
    .bind(...courseIds)
    .all<CourseIdRow>();
  const existing = new Set(rows.results.map((row) => row.id));

  return courseIds.filter((courseId) => !existing.has(courseId));
}

function findPath(
  adjacency: Map<string, string[]>,
  start: string,
  target: string,
): string[] | null {
  const stack: Array<{ node: string; path: string[] }> = [
    { node: start, path: [start] },
  ];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === undefined) {
      break;
    }

    if (current.node === target) {
      return current.path;
    }

    if (visited.has(current.node)) {
      continue;
    }

    visited.add(current.node);

    for (const neighbor of adjacency.get(current.node) ?? []) {
      stack.push({ node: neighbor, path: [...current.path, neighbor] });
    }
  }

  return null;
}

async function assertNoCycle(
  db: D1Database,
  courseId: string,
  prerequisites: PrerequisiteRule[],
): Promise<void> {
  const rows = await db
    .prepare("SELECT course_id, prerequisite_course_id FROM prerequisites")
    .all<PrerequisiteEdgeRow>();
  const adjacency = new Map<string, string[]>();

  for (const row of rows.results) {
    if (row.course_id === courseId) {
      continue;
    }

    const neighbors = adjacency.get(row.course_id) ?? [];
    neighbors.push(row.prerequisite_course_id);
    adjacency.set(row.course_id, neighbors);
  }

  for (const prerequisite of prerequisites) {
    const path = findPath(adjacency, prerequisite.courseId, courseId);

    if (path !== null) {
      throw new AppError(
        422,
        "prerequisite_cycle",
        "Prerequisite rules would introduce a cycle.",
        { path: [courseId, ...path] },
      );
    }
  }
}

export async function replacePrerequisites(
  db: D1Database,
  courseId: string,
  prerequisites: PrerequisiteRule[],
): Promise<PrerequisiteSet> {
  const course = await findCourseStatus(db, courseId);

  if (course === null) {
    throw new AppError(404, "not_found", "The requested resource was not found.");
  }

  const prerequisiteCourseIds = prerequisites.map(
    (prerequisite) => prerequisite.courseId,
  );
  const duplicateCourseIds = prerequisiteCourseIds.filter(
    (id, index) => prerequisiteCourseIds.indexOf(id) !== index,
  );

  if (duplicateCourseIds.length > 0) {
    throw new AppError(
      422,
      "validation_failed",
      "Prerequisite courses must be unique.",
      { duplicateCourseIds: [...new Set(duplicateCourseIds)] },
    );
  }

  if (prerequisiteCourseIds.includes(courseId)) {
    throw new AppError(
      422,
      "prerequisite_self_reference",
      "A course cannot be its own prerequisite.",
      { courseId },
    );
  }

  const missingCourseIds = await findMissingCourseIds(db, prerequisiteCourseIds);

  if (missingCourseIds.length > 0) {
    throw new AppError(
      422,
      "validation_failed",
      "One or more prerequisite courses do not exist.",
      { missingCourseIds },
    );
  }

  await assertNoCycle(db, courseId, prerequisites);

  const now = new Date().toISOString();
  const sorted = [...prerequisites].sort((left, right) =>
    left.courseId.localeCompare(right.courseId),
  );
  const statements = [
    db.prepare("DELETE FROM prerequisites WHERE course_id = ?").bind(courseId),
    ...sorted.map((prerequisite) =>
      db
        .prepare(
          `INSERT INTO prerequisites
             (course_id, prerequisite_course_id, is_required, minimum_grade)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          courseId,
          prerequisite.courseId,
          prerequisite.required ? 1 : 0,
          prerequisite.minimumGrade ?? null,
        ),
    ),
    db
      .prepare("UPDATE courses SET updated_at = ? WHERE id = ?")
      .bind(now, courseId),
  ];

  await db.batch(statements);

  return {
    courseId,
    prerequisites: sorted,
    updatedAt: now,
  };
}

export async function checkPrerequisites(
  db: D1Database,
  courseId: string,
  completedCourseIds: string[],
  includeUnpublished: boolean,
): Promise<PrerequisiteCheckResponse> {
  const course = await findCourseStatus(db, courseId);

  if (
    course === null ||
    (!includeUnpublished && course.status !== "published")
  ) {
    throw new AppError(404, "not_found", "The requested resource was not found.");
  }

  const rows = await db
    .prepare(
      `SELECT prerequisite_course_id
       FROM prerequisites
       WHERE course_id = ? AND is_required = 1
       ORDER BY prerequisite_course_id ASC`,
    )
    .bind(courseId)
    .all<{ prerequisite_course_id: string }>();
  const completed = new Set(completedCourseIds);
  const missing = rows.results
    .map((row) => row.prerequisite_course_id)
    .filter((id) => !completed.has(id));

  return {
    eligible: missing.length === 0,
    missing,
  };
}
