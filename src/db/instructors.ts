import type { z } from "zod";
import type {
  InstructorListResponseSchema,
  InstructorSchema,
  ListInstructorsQuerySchema,
} from "../schemas/instructor.js";
import {
  loadInstructorCourseIds,
  placeholders,
  toInstructor,
  type InstructorRow,
} from "./shared.js";

type Instructor = z.infer<typeof InstructorSchema>;
type InstructorListResponse = z.infer<typeof InstructorListResponseSchema>;
export type ListInstructorsQuery = z.infer<typeof ListInstructorsQuerySchema>;

const instructorColumns = `i.id, i.display_name, i.email, i.department, i.bio,
  i.created_at, i.updated_at`;

const sortColumns: Record<ListInstructorsQuery["sort"], string> = {
  name: "i.display_name COLLATE NOCASE",
  department: "i.department COLLATE NOCASE",
  createdAt: "i.created_at",
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listInstructors(
  db: D1Database,
  query: ListInstructorsQuery,
  includeUnpublished: boolean,
): Promise<InstructorListResponse> {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (query.q !== undefined) {
    const pattern = `%${escapeLike(query.q)}%`;
    conditions.push(
      `(i.display_name LIKE ? ESCAPE '\\' OR i.department LIKE ? ESCAPE '\\' OR i.bio LIKE ? ESCAPE '\\')`,
    );
    bindings.push(pattern, pattern, pattern);
  }

  if (query.department !== undefined) {
    conditions.push("i.department = ?");
    bindings.push(query.department);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM instructors i ${where}`)
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
      `SELECT ${instructorColumns}
       FROM instructors i
       ${where}
       ORDER BY ${sortColumns[query.sort]} ${direction}, i.id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, query.limit, offset)
    .all<InstructorRow>();
  const courseIdsByInstructor = await loadInstructorCourseIds(
    db,
    rows.results.map((row) => row.id),
    includeUnpublished,
  );

  return {
    data: rows.results.map((row) =>
      toInstructor(row, courseIdsByInstructor.get(row.id) ?? []),
    ),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getInstructor(
  db: D1Database,
  instructorId: string,
  includeUnpublished: boolean,
): Promise<Instructor | null> {
  const row = await db
    .prepare(
      `SELECT ${instructorColumns}
       FROM instructors i
       WHERE i.id = ?`,
    )
    .bind(instructorId)
    .first<InstructorRow>();

  if (row === null) {
    return null;
  }

  const courseIdsByInstructor = await loadInstructorCourseIds(
    db,
    [instructorId],
    includeUnpublished,
  );

  return toInstructor(row, courseIdsByInstructor.get(instructorId) ?? []);
}
