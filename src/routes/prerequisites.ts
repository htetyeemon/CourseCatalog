import { Hono } from "hono";
import {
  checkPrerequisites,
  replacePrerequisites,
} from "../db/prerequisites.js";
import {
  READ_ROLES,
  WRITE_ROLES,
  isCatalogAdmin,
  requireRole,
} from "../lib/auth.js";
import { apiError } from "../lib/errors.js";
import { parseJsonBody } from "../lib/validation.js";
import { CourseIdSchema } from "../schemas/common.js";
import {
  PrerequisiteCheckRequestSchema,
  PutPrerequisitesRequestSchema,
} from "../schemas/prerequisite.js";
import type { AppEnv } from "../types.js";

export const coursePrerequisitesRoute = new Hono<AppEnv>();

coursePrerequisitesRoute.put(
  "/:courseId/prerequisites",
  requireRole(...WRITE_ROLES),
  async (c) => {
    const courseId = CourseIdSchema.safeParse(c.req.param("courseId"));

    if (!courseId.success) {
      return apiError(c, 400, "invalid_request", "Invalid course ID.");
    }

    const body = await parseJsonBody(c, PutPrerequisitesRequestSchema);

    if (!body.success) {
      return body.response;
    }

    const prerequisites = await replacePrerequisites(
      c.env.DB,
      courseId.data,
      body.data.prerequisites,
    );

    return c.json({ data: prerequisites });
  },
);

export const prerequisitesRoute = new Hono<AppEnv>();

prerequisitesRoute.post(
  "/check",
  requireRole(...READ_ROLES),
  async (c) => {
    const body = await parseJsonBody(c, PrerequisiteCheckRequestSchema);

    if (!body.success) {
      return body.response;
    }

    const result = await checkPrerequisites(
      c.env.DB,
      body.data.courseId,
      body.data.completedCourseIds,
      isCatalogAdmin(c.get("auth")),
    );

    return c.json(result);
  },
);
