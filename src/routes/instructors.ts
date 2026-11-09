import { Hono } from "hono";
import { getInstructor, listInstructors } from "../db/instructors.js";
import { READ_ROLES, isCatalogAdmin, requireRole } from "../lib/auth.js";
import { apiError } from "../lib/errors.js";
import { InstructorIdSchema } from "../schemas/common.js";
import { ListInstructorsQuerySchema } from "../schemas/instructor.js";
import type { AppEnv } from "../types.js";

export const instructorsRoute = new Hono<AppEnv>();

instructorsRoute.get("/", requireRole(...READ_ROLES), async (c) => {
  const parsed = ListInstructorsQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );

  if (!parsed.success) {
    return apiError(c, 400, "invalid_request", "Invalid query parameters.", {
      issues: parsed.error.issues,
    });
  }

  const result = await listInstructors(
    c.env.DB,
    parsed.data,
    isCatalogAdmin(c.get("auth")),
  );

  return c.json(result);
});

instructorsRoute.get(
  "/:instructorId",
  requireRole(...READ_ROLES),
  async (c) => {
    const parsed = InstructorIdSchema.safeParse(c.req.param("instructorId"));

    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid instructor ID.");
    }

    const instructor = await getInstructor(
      c.env.DB,
      parsed.data,
      isCatalogAdmin(c.get("auth")),
    );

    if (instructor === null) {
      return apiError(
        c,
        404,
        "not_found",
        "The requested resource was not found.",
      );
    }

    return c.json({ data: instructor });
  },
);
