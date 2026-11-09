import { describe, expect, it } from "vitest";
import YAML from "yaml";
import openapiDocument from "../src/openapi.json";
import openapiSource from "../openapi.yaml?raw";
import type { z } from "zod";
import {
  CourseDetailResponseSchema,
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
  PrerequisiteCheckRequestSchema,
  PrerequisiteCheckResponseSchema,
  PrerequisitesResponseSchema,
  PutPrerequisitesRequestSchema,
  UpdateCourseRequestSchema,
  WebhookDeliveryListResponseSchema,
  WebhookSubscriptionCreatedResponseSchema,
} from "../src/schemas/index.js";

type Operation = {
  security?: unknown[];
  "x-required-roles"?: unknown;
};

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: {
    examples: Record<string, { value: unknown }>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

const document = YAML.parse(openapiSource) as OpenApiDocument;

const httpMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

const exampleSchemas: Record<string, z.ZodType> = {
  CourseResponse: CourseResponseSchema,
  CourseDetailResponse: CourseDetailResponseSchema,
  PublishedCourseResponse: CourseResponseSchema,
  CourseListResponse: CourseListResponseSchema,
  CreateCourseRequest: CreateCourseRequestSchema,
  UpdateCourseRequest: UpdateCourseRequestSchema,
  InstructorResponse: InstructorResponseSchema,
  InstructorListResponse: InstructorListResponseSchema,
  PutPrerequisitesRequest: PutPrerequisitesRequestSchema,
  PrerequisitesResponse: PrerequisitesResponseSchema,
  PrerequisiteCheckRequest: PrerequisiteCheckRequestSchema,
  PrerequisiteCheckResponse: PrerequisiteCheckResponseSchema,
  EligibilityCheckRequest: EligibilityCheckRequestSchema,
  EligibilityCheckResponse: EligibilityCheckResponseSchema,
  CreateWebhookSubscriptionRequest: CreateWebhookSubscriptionRequestSchema,
  WebhookSubscriptionCreatedResponse: WebhookSubscriptionCreatedResponseSchema,
  WebhookDeliveryListResponse: WebhookDeliveryListResponseSchema,
  CoursePublishedEvent: CoursePublishedEventSchema,
  HealthResponse: HealthResponseSchema,
  InvalidRequestError: ErrorResponseSchema,
  UnauthorizedError: ErrorResponseSchema,
  ForbiddenError: ErrorResponseSchema,
  NotFoundError: ErrorResponseSchema,
  ConflictError: ErrorResponseSchema,
  ValidationFailedError: ErrorResponseSchema,
  RateLimitedError: ErrorResponseSchema,
  InternalError: ErrorResponseSchema,
  ServiceUnavailableError: ErrorResponseSchema,
};

describe("openapi contract", () => {
  it("is OpenAPI 3.1", () => {
    expect(document.openapi).toMatch(/^3\.1\./);
  });

  it("keeps the served JSON copy in sync with the YAML source", () => {
    expect(openapiDocument).toEqual(document);
  });

  it("keeps every route under /v1", () => {
    for (const path of Object.keys(document.paths)) {
      expect(path.startsWith("/v1/"), path).toBe(true);
    }
  });

  it("declares roles for every authenticated operation and leaves health public", () => {
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) {
          continue;
        }

        const typedOperation = operation as Operation;
        if (path === "/v1/health") {
          expect(typedOperation.security, path).toEqual([]);
        } else {
          expect(
            typedOperation["x-required-roles"],
            `${method.toUpperCase()} ${path}`,
          ).toBeDefined();
        }
      }
    }
  });

  it("keeps the standard error envelope shape", () => {
    const error = document.components.schemas.Error;
    expect(error?.required).toEqual(
      expect.arrayContaining(["code", "message", "requestId"]),
    );

    const errorResponse = document.components.schemas.ErrorResponse;
    expect(errorResponse?.required).toEqual(["error"]);
  });

  it("keeps paginated list responses flat", () => {
    for (const name of [
      "CourseListResponse",
      "InstructorListResponse",
      "WebhookDeliveryListResponse",
    ]) {
      const schema = document.components.schemas[name];
      expect(schema?.required, name).toEqual(
        expect.arrayContaining(["data", "page", "limit", "total"]),
      );
    }
  });

  it.each(Object.entries(exampleSchemas))(
    "validates the %s example against its Zod schema",
    (name, schema) => {
      const example = document.components.examples[name];
      expect(example, `Missing components.examples.${name}`).toBeDefined();

      const result = schema.safeParse(example?.value);
      if (!result.success) {
        throw new Error(
          `${name} example does not match its schema: ${JSON.stringify(
            result.error.issues,
          )}`,
        );
      }
    },
  );
});
