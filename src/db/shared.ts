import type { z } from "zod";
import type { InstructorSchema } from "../schemas/instructor.js";
import type { PrerequisiteRuleSchema } from "../schemas/prerequisite.js";

export type Instructor = z.infer<typeof InstructorSchema>;
export type PrerequisiteRule = z.infer<typeof PrerequisiteRuleSchema>;

export interface InstructorRow {
  id: string;
  display_name: string;
  email: string;
  department: string;
  bio: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrerequisiteRow {
  prerequisite_course_id: string;
  is_required: number;
  minimum_grade: number | null;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function toInstructor(row: InstructorRow, courseIds: string[]): Instructor {
  const instructor: Instructor = {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    department: row.department,
    courseIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.bio !== null) {
    instructor.bio = row.bio;
  }

  return instructor;
}

export function toPrerequisite(row: PrerequisiteRow): PrerequisiteRule {
  const prerequisite: PrerequisiteRule = {
    courseId: row.prerequisite_course_id,
    required: row.is_required === 1,
  };

  if (row.minimum_grade !== null) {
    prerequisite.minimumGrade = row.minimum_grade;
  }

  return prerequisite;
}

export async function loadInstructorCourseIds(
  db: D1Database,
  instructorIds: string[],
  includeUnpublished: boolean,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  if (instructorIds.length === 0) {
    return result;
  }

  const visibility = includeUnpublished ? "" : "AND c.status = 'published'";
  const rows = await db
    .prepare(
      `SELECT ci.instructor_id, ci.course_id
       FROM course_instructors ci
       JOIN courses c ON c.id = ci.course_id
       WHERE ci.instructor_id IN (${placeholders(instructorIds.length)}) ${visibility}
       ORDER BY ci.instructor_id ASC, ci.position ASC, ci.course_id ASC`,
    )
    .bind(...instructorIds)
    .all<{ instructor_id: string; course_id: string }>();

  for (const row of rows.results) {
    const courseIds = result.get(row.instructor_id) ?? [];
    courseIds.push(row.course_id);
    result.set(row.instructor_id, courseIds);
  }

  return result;
}
