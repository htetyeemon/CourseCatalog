import { Hono } from "hono";
import {
  createCourse,
  getCourse,
  listCourses,
  updateCourse,
} from "../db/courses.js";
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
  CreateCourseRequestSchema,
  ListCoursesQuerySchema,
  UpdateCourseRequestSchema,
} from "../schemas/course.js";
import {
  EnrichmentService,
  AiEnrichmentProvider,
  DeterministicEnrichmentProvider,
  loadValidCourseIds,
  type AiRun,
} from "../lib/enrichment.js";
import {
  buildSignatureHeader,
  attemptDeliveryForPublish,
} from "../lib/delivery.js";
import { getActiveSubscriptions, createDelivery } from "../db/webhooks.js";
import { makeId } from "../lib/ids.js";
import type { AppEnv } from "../types.js";

export const coursesRoute = new Hono<AppEnv>();

coursesRoute.get("/", requireRole(...READ_ROLES), async (c) => {
  const parsed = ListCoursesQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );

  if (!parsed.success) {
    return apiError(c, 400, "invalid_request", "Invalid query parameters.", {
      issues: parsed.error.issues,
    });
  }

  const result = await listCourses(
    c.env.DB,
    parsed.data,
    isCatalogAdmin(c.get("auth")),
  );

  return c.json(result);
});

coursesRoute.get("/:courseId", requireRole(...READ_ROLES), async (c) => {
  const parsed = CourseIdSchema.safeParse(c.req.param("courseId"));

  if (!parsed.success) {
    return apiError(c, 400, "invalid_request", "Invalid course ID.");
  }

  const course = await getCourse(
    c.env.DB,
    parsed.data,
    isCatalogAdmin(c.get("auth")),
  );

  if (course === null) {
    return apiError(c, 404, "not_found", "The requested resource was not found.");
  }

  return c.json({ data: course });
});

coursesRoute.post("/", requireRole(...WRITE_ROLES), async (c) => {
  const body = await parseJsonBody(c, CreateCourseRequestSchema);

  if (!body.success) {
    return body.response;
  }

  const course = await createCourse(c.env.DB, body.data);

  c.header("Location", `/v1/courses/${course.id}`);
  return c.json({ data: course }, 201);
});

coursesRoute.patch("/:courseId", requireRole(...WRITE_ROLES), async (c) => {
  const parsed = CourseIdSchema.safeParse(c.req.param("courseId"));

  if (!parsed.success) {
    return apiError(c, 400, "invalid_request", "Invalid course ID.");
  }

  const body = await parseJsonBody(c, UpdateCourseRequestSchema);

  if (!body.success) {
    return body.response;
  }

  const course = await updateCourse(c.env.DB, parsed.data, body.data);

  return c.json({ data: course });
});

coursesRoute.post(
  "/:courseId/publish",
  requireRole(...WRITE_ROLES),
  async (c) => {
    const parsed = CourseIdSchema.safeParse(c.req.param("courseId"));

    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid course ID.");
    }

    const courseId = parsed.data;
    const course = await getCourse(c.env.DB, courseId, true);

    if (course === null) {
      return apiError(c, 404, "not_found", "The requested resource was not found.");
    }

    if (course.status !== "draft") {
      return apiError(
        c,
        409,
        "conflict",
        "Only draft courses can be published.",
        { status: course.status },
      );
    }

    if (!course.instructorIds || course.instructorIds.length === 0) {
      return apiError(
        c,
        422,
        "validation_failed",
        "A course must have at least one instructor before it can be published.",
        { courseId },
      );
    }

    const validCourseIds = await loadValidCourseIds(c.env.DB);

    // `run` must stay bound to the AI binding; a detached call throws and would
    // silently force the deterministic fallback on every publish.
    const ai = c.env.AI as { run?: (...args: unknown[]) => Promise<unknown> } | undefined;
    const aiRun: AiRun | null =
      ai && typeof ai.run === "function" ? (ai.run.bind(ai) as AiRun) : null;

    const enrichmentService = new EnrichmentService(
      new AiEnrichmentProvider(aiRun, validCourseIds, c.env.AI_MODEL),
      new DeterministicEnrichmentProvider(),
    );

    const enrichment = await enrichmentService.enrich({
      description: course.description,
      department: course.department,
      code: course.code,
      title: course.title,
    });

    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(enrichment.tags);

    const update = await c.env.DB
      .prepare(
        `UPDATE courses
         SET status = 'published',
             published_at = ?,
             summary = ?,
             tags = ?,
             enrichment_source = ?,
             updated_at = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .bind(now, enrichment.summary, tagsJson, enrichment.source, now, courseId)
      .run();

    if (update.meta.changes === 0) {
      // Lost a race with a concurrent publish/archive; that request emitted the event.
      return apiError(c, 409, "conflict", "Only draft courses can be published.", { courseId });
    }

    const publishedCourse = await getCourse(c.env.DB, courseId, true);

    if (publishedCourse === null) {
      return apiError(c, 500, "internal_error", "Published course could not be loaded.");
    }

    const eventId = makeId("evt");
    const eventBody = JSON.stringify({
      id: eventId,
      type: "course.published",
      version: "1.0",
      occurredAt: now,
      data: {
        course: publishedCourse,
        instructors: publishedCourse.instructors ?? [],
        prerequisites: publishedCourse.prerequisites ?? [],
        enrichment: {
          summary: enrichment.summary,
          tags: enrichment.tags,
          suggestedPrerequisites: enrichment.suggestedPrerequisites,
          source: enrichment.source,
        },
      },
    });

    const subscriptions = await getActiveSubscriptions(c.env.DB);
    const targetSubscriptions = subscriptions.filter((subscription) =>
      subscription.events.includes("course.published"),
    );

    const deliveries = await Promise.all(
      targetSubscriptions.map((subscription) =>
        createDelivery(c.env.DB, {
          subscriptionId: subscription.id,
          eventId,
          eventType: "course.published",
          requestBody: eventBody,
        }),
      ),
    );

    await Promise.all(
      deliveries.map((delivery, index) =>
        attemptDeliveryForPublish(
          c.env.DB,
          delivery.id,
          targetSubscriptions[index],
          eventId,
          eventBody,
        ),
      ),
    );

    return c.json({ data: publishedCourse });
  },
);
