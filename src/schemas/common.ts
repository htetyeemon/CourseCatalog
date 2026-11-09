import { z } from "zod";

export const CourseIdSchema = z
  .string()
  .regex(/^crs_[A-Za-z0-9]{8,32}$/, "Must be a crs_ prefixed course ID.");

export const InstructorIdSchema = z
  .string()
  .regex(/^ins_[A-Za-z0-9]{8,32}$/, "Must be an ins_ prefixed instructor ID.");

export const StudentIdSchema = z
  .string()
  .regex(/^stu_[A-Za-z0-9]{8,32}$/, "Must be a stu_ prefixed student ID.");

export const WebhookSubscriptionIdSchema = z
  .string()
  .regex(/^whs_[A-Za-z0-9]{8,32}$/, "Must be a whs_ prefixed subscription ID.");

export const WebhookDeliveryIdSchema = z
  .string()
  .regex(/^whd_[A-Za-z0-9]{8,32}$/, "Must be a whd_ prefixed delivery ID.");

export const EventIdSchema = z
  .string()
  .regex(/^evt_[A-Za-z0-9]{8,32}$/, "Must be an evt_ prefixed event ID.");

export const RequestIdSchema = z
  .string()
  .regex(/^req_[A-Za-z0-9]{8,32}$/, "Must be a req_ prefixed request ID.");

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const RoleSchema = z.enum([
  "student",
  "instructor",
  "catalog_admin",
  "service",
]);

export const SortOrderSchema = z.enum(["asc", "desc"]);

export const PageQuerySchema = z.coerce.number().int().min(1).default(1);
export const LimitQuerySchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20);

export const PageSchema = z.number().int().min(1);
export const LimitSchema = z.number().int().min(1).max(100);
export const TotalSchema = z.number().int().min(0);

export const paginationQueryShape = {
  page: PageQuerySchema,
  limit: LimitQuerySchema,
};

export const PaginationQuerySchema = z
  .object(paginationQueryShape)
  .strict();

export const ErrorCodeSchema = z.enum([
  "invalid_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
  "service_unavailable",
]);

export const ErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: ErrorSchema,
  })
  .strict();
