import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CourseListResponseSchema,
  CoursePublishedEventSchema,
  CourseResponseSchema,
  CreateCourseRequestSchema,
  CreateWebhookSubscriptionRequestSchema,
  EligibilityCheckRequestSchema,
  EligibilityCheckResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  InstructorListResponseSchema,
  InstructorResponseSchema,
  ListCoursesQuerySchema,
  ListInstructorsQuerySchema,
  ListWebhookDeliveriesQuerySchema,
  PrerequisitesResponseSchema,
  PutPrerequisitesRequestSchema,
  UpdateCourseRequestSchema,
  WebhookDeliveryListResponseSchema,
  WebhookSubscriptionCreatedResponseSchema,
} from "../src/schemas/index.js";

function expectValid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data;
}

const course = {
  id: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2D",
  code: "CS-101",
  title: "Introduction to Computer Science",
  description:
    "Foundational course covering algorithms, data structures, and programming in Python.",
  status: "published",
  credits: 4,
  level: "introductory",
  department: "Computer Science",
  instructorIds: ["ins_01J9ZK5A1B2C3D4E5F6G7H8J9K"],
  createdAt: "2026-01-15T09:00:00Z",
  updatedAt: "2026-03-01T15:00:00Z",
  publishedAt: "2026-03-01T15:00:00Z",
};

const instructor = {
  id: "ins_01J9ZK5A1B2C3D4E5F6G7H8J9K",
  displayName: "Dr. Ada Lovelace",
  email: "ada@example.edu",
  department: "Computer Science",
  bio: "Teaching algorithms and programming foundations.",
  courseIds: ["crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2D"],
  createdAt: "2026-01-10T08:00:00Z",
  updatedAt: "2026-02-10T10:15:00Z",
};

describe("common envelopes", () => {
  it("accepts the standard error envelope", () => {
    const parsed = expectValid(ErrorResponseSchema, {
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        details: {
          fields: [
            { path: "credits", message: "Must be between 0 and 30." },
          ],
        },
        requestId: "req_01J9ZKAF6G7H8J9K0M1N2P3Q4R",
      },
    });

    expect(parsed.error.code).toBe("validation_failed");
  });

  it("rejects an error envelope with a bad request ID", () => {
    const result = ErrorResponseSchema.safeParse({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
        requestId: "not-a-request-id",
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("courses", () => {
  it("accepts a course response", () => {
    expectValid(CourseResponseSchema, { data: course });
  });

  it("accepts a paginated course list", () => {
    expectValid(CourseListResponseSchema, {
      data: [course],
      page: 1,
      limit: 20,
      total: 1,
    });
  });

  it("accepts a create course request", () => {
    expectValid(CreateCourseRequestSchema, {
      code: "CS-201",
      title: "Data Structures",
      description:
        "Core data structures, complexity analysis, and implementation techniques.",
      credits: 4,
      level: "intermediate",
      department: "Computer Science",
      instructorIds: ["ins_01J9ZK5A1B2C3D4E5F6G7H8J9K"],
    });
  });

  it("accepts a non-empty partial update", () => {
    expectValid(UpdateCourseRequestSchema, {
      title: "Data Structures and Algorithms",
      credits: 4,
    });
  });

  it("rejects an empty partial update", () => {
    expect(UpdateCourseRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = CourseResponseSchema.safeParse({
      data: { ...course, unknownField: true },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a course ID with the wrong prefix", () => {
    const result = CourseResponseSchema.safeParse({
      data: { ...course, id: "ins_01J9ZK4Q7M2W8N5R3T6Y0B1C2D" },
    });

    expect(result.success).toBe(false);
  });

  it("applies course list query defaults and coerces query strings", () => {
    const parsed = expectValid(ListCoursesQuerySchema, {
      page: "2",
      limit: "50",
    });

    expect(parsed.page).toBe(2);
    expect(parsed.limit).toBe(50);
    expect(parsed.sort).toBe("title");
    expect(parsed.order).toBe("asc");
  });
});

describe("instructors", () => {
  it("accepts an instructor response", () => {
    expectValid(InstructorResponseSchema, { data: instructor });
  });

  it("accepts a paginated instructor list", () => {
    expectValid(InstructorListResponseSchema, {
      data: [instructor],
      page: 1,
      limit: 20,
      total: 1,
    });
  });

  it("applies instructor list query defaults", () => {
    const parsed = expectValid(ListInstructorsQuerySchema, {});

    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(20);
    expect(parsed.sort).toBe("name");
    expect(parsed.order).toBe("asc");
  });
});

describe("prerequisites and eligibility", () => {
  it("accepts a prerequisite replacement request and response", () => {
    expectValid(PutPrerequisitesRequestSchema, {
      prerequisites: [
        {
          courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2E",
          required: true,
          minimumGrade: 70,
        },
        { courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2F", required: false },
      ],
    });

    expectValid(PrerequisitesResponseSchema, {
      data: {
        courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2D",
        prerequisites: [
          {
            courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2E",
            required: true,
            minimumGrade: 70,
          },
        ],
        updatedAt: "2026-03-01T15:00:00Z",
      },
    });
  });

  it("defaults a missing prerequisite required flag to true", () => {
    const parsed = expectValid(PutPrerequisitesRequestSchema, {
      prerequisites: [{ courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2E" }],
    });

    expect(parsed.prerequisites[0]?.required).toBe(true);
  });

  it("accepts eligibility requests and results", () => {
    expectValid(EligibilityCheckRequestSchema, {
      studentId: "stu_01J9ZK6B2C3D4E5F6G7H8J9K0M",
    });

    expectValid(EligibilityCheckResponseSchema, {
      data: {
        studentId: "stu_01J9ZK6B2C3D4E5F6G7H8J9K0M",
        courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2D",
        eligible: false,
        evaluatedAt: "2026-03-02T09:30:00Z",
        checks: [
          {
            courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2E",
            required: true,
            satisfied: true,
            minimumGrade: 70,
            earnedGrade: 84,
            reason: "satisfied",
          },
          {
            courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2F",
            required: false,
            satisfied: false,
            reason: "not_completed",
          },
        ],
      },
    });
  });
});

describe("webhooks", () => {
  it("accepts a subscription creation request", () => {
    expectValid(CreateWebhookSubscriptionRequestSchema, {
      url: "https://lms.example.com/webhooks/catalog",
      events: ["course.published"],
      description: "LMS synchronization",
    });
  });

  it("rejects a non-HTTPS subscription URL", () => {
    const result = CreateWebhookSubscriptionRequestSchema.safeParse({
      url: "http://lms.example.com/webhooks/catalog",
      events: ["course.published"],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a created subscription with a one-time signing secret", () => {
    expectValid(WebhookSubscriptionCreatedResponseSchema, {
      data: {
        id: "whs_01J9ZK7C3D4E5F6G7H8J9K0M1N",
        url: "https://lms.example.com/webhooks/catalog",
        events: ["course.published"],
        status: "active",
        description: "LMS synchronization",
        createdAt: "2026-03-01T15:00:00Z",
        updatedAt: "2026-03-01T15:00:00Z",
        signingSecret: "whsec_example_do_not_use_6f1c9a2e7b4d8f0a",
      },
    });
  });

  it("rejects a short signing secret", () => {
    const result = WebhookSubscriptionCreatedResponseSchema.safeParse({
      data: {
        id: "whs_01J9ZK7C3D4E5F6G7H8J9K0M1N",
        url: "https://lms.example.com/webhooks/catalog",
        events: ["course.published"],
        status: "active",
        createdAt: "2026-03-01T15:00:00Z",
        updatedAt: "2026-03-01T15:00:00Z",
        signingSecret: "short",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a paginated delivery list and query filters", () => {
    expectValid(WebhookDeliveryListResponseSchema, {
      data: [
        {
          id: "whd_01J9ZK8D4E5F6G7H8J9K0M1N2P",
          subscriptionId: "whs_01J9ZK7C3D4E5F6G7H8J9K0M1N",
          eventId: "evt_01J9ZK9E5F6G7H8J9K0M1N2P3Q",
          eventType: "course.published",
          status: "delivered",
          attempt: 1,
          maxAttempts: 6,
          responseStatus: 200,
          createdAt: "2026-03-01T15:00:01Z",
          lastAttemptAt: "2026-03-01T15:00:02Z",
          deliveredAt: "2026-03-01T15:00:02Z",
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
    });

    expectValid(ListWebhookDeliveriesQuerySchema, {
      subscriptionId: "whs_01J9ZK7C3D4E5F6G7H8J9K0M1N",
      status: "delivered",
      eventType: "course.published",
    });
  });

  it("accepts the course.published event envelope", () => {
    expectValid(CoursePublishedEventSchema, {
      id: "evt_01J9ZK9E5F6G7H8J9K0M1N2P3Q",
      type: "course.published",
      version: "1.0",
      occurredAt: "2026-03-01T15:00:00Z",
      data: {
        course,
        instructors: [instructor],
        prerequisites: [
          {
            courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2E",
            required: true,
            minimumGrade: 70,
          },
          { courseId: "crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2F", required: false },
        ],
        enrichment: {
          summary:
            "A foundational computer science course covering programming, algorithms, and problem solving.",
          tags: ["programming", "algorithms", "foundations"],
          suggestedPrerequisites: ["crs_01J9ZK4Q7M2W8N5R3T6Y0B1C2F"],
          source: "ai",
        },
      },
    });
  });

  it("rejects an unsupported event version", () => {
    const result = CoursePublishedEventSchema.safeParse({
      id: "evt_01J9ZK9E5F6G7H8J9K0M1N2P3Q",
      type: "course.published",
      version: "2.0",
      occurredAt: "2026-03-01T15:00:00Z",
      data: {
        course,
        instructors: [instructor],
        prerequisites: [],
        enrichment: {
          summary: "Summary.",
          tags: [],
          suggestedPrerequisites: [],
          source: "fallback",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("health", () => {
  it("accepts a healthy response and a degraded response", () => {
    expectValid(HealthResponseSchema, {
      status: "ok",
      version: "1.0.0",
      timestamp: "2026-03-01T15:00:00Z",
      checks: { database: "ok", ai: "ok" },
    });

    expectValid(HealthResponseSchema, {
      status: "degraded",
      version: "1.0.0",
      timestamp: "2026-03-01T15:00:00Z",
      checks: { database: "ok", ai: "degraded" },
    });
  });
});
